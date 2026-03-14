import type { Response } from "express";
import { Readable } from "node:stream";
import { generateId } from "ai";

import { MAX_RESPONSE_SEGMENTS, MAX_TOKENS, type FileMap } from "../llm/constants";
import { streamText, type Messages, type StreamingOptions } from "../llm/stream-text";
import type { ProgressAnnotation, ContextAnnotation } from "../types/context";
import { MCPService } from "../llm/mcpService";
import { CONTINUE_PROMPT } from "../prompts/prompts";
import { extractPropertiesFromMessage } from "../llm/utils";

import {
  logger,
  safeJson,
  writeDataPart,
  writeMessageAnnotationPart,
  normalizePathForUI,
  chunkFileMap,
  MAX_CONTEXT_FILES,
  type ChatContext,
} from "./chat-shared";

async function pipeWebStreamToExpress(opts: {
  requestId: string;
  res: Response;
  webStream: ReadableStream;
}): Promise<void> {
  const { requestId, res, webStream } = opts;

  if (res.writableEnded || res.destroyed) {
    logger.warn(`[${requestId}] Response already ended before piping, skipping`);
    return;
  }

  const nodeStream = Readable.fromWeb(webStream as any);

  let bytesWritten = 0;
  let chunksWritten = 0;
  nodeStream.on("data", (chunk) => {
    bytesWritten += chunk.length;
    chunksWritten++;
    if (chunksWritten % 10 === 0) {
      logger.info(`[${requestId}] Streaming progress: ${chunksWritten} chunks, ${bytesWritten} bytes`);
    }
  });

  nodeStream.pipe(res, { end: false });

  return new Promise<void>((resolve, reject) => {
    nodeStream.on("end", () => {
      logger.info(`[${requestId}] nodeStream ended - total: ${chunksWritten} chunks, ${bytesWritten} bytes`);
      resolve();
    });
    nodeStream.on("error", (err) => {
      logger.error(`[${requestId}] nodeStream error: ${err?.message || err}`, err);
      reject(err);
    });
  });
}

export async function handleDiscuss(
  ctx: ChatContext,
  res: Response,
  processedMessages: Messages,
  filteredFiles: FileMap | undefined,
  summary: string | undefined,
  messageSliceId: number,
): Promise<void> {
  const {
    requestId,
    startedAt,
    body,
    shouldAbort,
    cumulativeUsage,
    dataStreamAdapter,
  } = ctx;
  let { progressCounter } = ctx;
  const { files, promptId, contextOptimization, chatMode, designScheme, supabase, maxLLMSteps, apiKeys, providerSettings } = body;

  const mcpService = MCPService.getInstance();

  const contextBatches: FileMap[] =
    filteredFiles && Object.keys(filteredFiles).length > MAX_CONTEXT_FILES
      ? chunkFileMap(filteredFiles, MAX_CONTEXT_FILES)
      : filteredFiles
        ? [filteredFiles]
        : [undefined as any];

  const totalBatches = contextBatches.filter(Boolean).length || 1;

  if (filteredFiles && Object.keys(filteredFiles).length > MAX_CONTEXT_FILES) {
    writeDataPart(res, {
      type: "progress",
      label: "context",
      status: "in-progress",
      order: progressCounter++,
      message: `Too many files selected (${Object.keys(filteredFiles).length}). Processing in ${totalBatches} batches of ${MAX_CONTEXT_FILES}.`,
    } satisfies ProgressAnnotation);
  }

  writeDataPart(res, {
    type: "progress",
    label: "response",
    status: "in-progress",
    order: progressCounter++,
    message: "Generating Response",
  } satisfies ProgressAnnotation);

  const optionsBase: StreamingOptions = {
    supabaseConnection: supabase,
    toolChoice: "auto",
    tools: mcpService.toolsWithoutExecute,
    maxSteps: maxLLMSteps,
    onStepFinish: ({ toolCalls }: any) => {
      for (const toolCall of toolCalls || []) {
        mcpService.processToolCall(toolCall, dataStreamAdapter as any);
      }
    },
  };

  const workingMessages = [...processedMessages];

  for (let batchIndex = 0; batchIndex < contextBatches.length; batchIndex++) {
    const batchFiles = contextBatches[batchIndex];
    const batchNum = batchIndex + 1;

    if (batchFiles) {
      writeMessageAnnotationPart(res, {
        type: "codeContext",
        files: Object.keys(batchFiles).map(normalizePathForUI),
      } as ContextAnnotation);
    }

    if (batchIndex > 0) {
      workingMessages.push({
        id: generateId(),
        role: "user",
        content: `We are continuing the same task, but now processing the next subset of files (batch ${batchNum}/${totalBatches}). Use ONLY the files in the current context buffer. Continue from where you left off and avoid repeating previous output.`,
      } as any);
    }

    let switches = 0;
    let done = false;

    while (!done) {
      if (shouldAbort()) {
        logger.info(`[${requestId}] Client disconnected, aborting streaming loop`);
        break;
      }

      let finishReason: string | undefined;
      let finalText: string | undefined;

      const options: StreamingOptions = {
        ...optionsBase,
        onFinish: async ({ text, finishReason: fr, usage }: any) => {
          finishReason = fr;
          finalText = text;

          if (usage) {
            cumulativeUsage.completionTokens += usage.completionTokens || 0;
            cumulativeUsage.promptTokens += usage.promptTokens || 0;
            cumulativeUsage.totalTokens += usage.totalTokens || 0;
          }
        },
      };

      logger.info(`[${requestId}] Calling streamText() batch=${batchNum}/${totalBatches} segment=${switches + 1}`);

      const result = await streamText({
        messages: [...workingMessages],
        env: undefined as any,
        options,
        apiKeys,
        files: files as FileMap,
        providerSettings,
        promptId,
        contextOptimization,
        contextFiles: batchFiles,
        chatMode,
        designScheme,
        summary,
        messageSliceId,
      });

      const response = result.toDataStreamResponse();

      if (!response.body) {
        throw new Error("toDataStreamResponse() returned empty body");
      }

      logger.info(`[${requestId}] About to pipe web stream to express`);
      await pipeWebStreamToExpress({
        requestId,
        res,
        webStream: response.body as any,
      });

      if (finishReason !== "length") {
        writeMessageAnnotationPart(res, {
          type: "usage",
          value: {
            completionTokens: cumulativeUsage.completionTokens,
            promptTokens: cumulativeUsage.promptTokens,
            totalTokens: cumulativeUsage.totalTokens,
          },
        });

        writeDataPart(res, {
          type: "progress",
          label: "response",
          status: "complete",
          order: progressCounter++,
          message: "Response Generated",
        } satisfies ProgressAnnotation);

        done = true;
        break;
      }

      switches += 1;

      if (switches >= MAX_RESPONSE_SEGMENTS) {
        throw new Error("Cannot continue message: Maximum segments reached");
      }

      const switchesLeft = MAX_RESPONSE_SEGMENTS - switches;
      logger.info(
        `[${requestId}] Reached max token limit (${MAX_TOKENS}). Continuing... (${switchesLeft} switches left)`,
      );

      const lastUserMessage = workingMessages.filter((x: any) => x.role === "user").slice(-1)[0];
      const { model, provider } = extractPropertiesFromMessage(lastUserMessage);

      workingMessages.push({ id: generateId(), role: "assistant", content: finalText || "" } as any);
      workingMessages.push({
        id: generateId(),
        role: "user",
        content: `[Model: ${model}]\n\n[Provider: ${provider}]\n\n${CONTINUE_PROMPT}`,
      } as any);
    }

    if (totalBatches > 1) {
      writeDataPart(res, {
        type: "progress",
        label: "response",
        status: "in-progress",
        order: progressCounter++,
        message: `Batch ${batchNum}/${totalBatches} complete`,
      } satisfies ProgressAnnotation);
    }
  }

  ctx.progressCounter = progressCounter;

  res.end();
  logger.info(`[${requestId}] Streaming ended elapsedMs=${Date.now() - startedAt}`);
}

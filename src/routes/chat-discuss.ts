import type { Response } from "express";
import { Readable } from "node:stream";
import { generateId } from "ai";

import { MAX_RESPONSE_SEGMENTS, MAX_TOKENS, type FileMap } from "../llm/constants";
import { streamText, type Messages, type StreamingOptions } from "../llm/stream-text";
import type { ProgressAnnotation, ContextAnnotation } from "../types/context";
import { MCPService } from "../llm/mcpService";
import { CONTINUE_PROMPT } from "../prompts/prompts";
import { extractPropertiesFromMessage } from "../llm/utils";
import { StreamGuard } from "../llm/stream-recovery";
import { AgentRecoveryController } from "../llm/agent-recovery";

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

const STREAM_ACTIVITY_TIMEOUT_MS = 30_000;
const STREAM_HEARTBEAT_INTERVAL_MS = 5_000;

async function pipeWebStreamToExpress(opts: {
  requestId: string;
  res: Response;
  webStream: ReadableStream;
  guard: StreamGuard;
}): Promise<void> {
  const { requestId, res, webStream, guard } = opts;

  if (res.writableEnded || res.destroyed) {
    logger.warn(`[${requestId}] Response already ended before piping, skipping`);
    return;
  }

  const nodeStream = Readable.fromWeb(webStream as any);

  let bytesWritten = 0;
  let chunksWritten = 0;

  nodeStream.on("data", (chunk) => {
    const len = chunk.length || 0;
    bytesWritten += len;
    chunksWritten++;
    guard.recordActivity(len);

    if (chunksWritten % 10 === 0) {
      logger.info(`[${requestId}] Streaming: ${chunksWritten} chunks, ${bytesWritten} bytes`);
    }
  });

  nodeStream.pipe(res, { end: false });

  return new Promise<void>((resolve, reject) => {
    nodeStream.on("end", () => {
      logger.info(`[${requestId}] Stream ended: ${chunksWritten} chunks, ${bytesWritten} bytes`);
      resolve();
    });
    nodeStream.on("error", (err) => {
      logger.error(`[${requestId}] Stream error: ${err?.message || err}`, err);
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
  const recovery = new AgentRecoveryController({ repeatToolThreshold: 3, noProgressThreshold: 3, timeoutThreshold: 2 });

  const OPTIMAL_BATCH_SIZE = 10;
  const MAX_RECOMMENDED_FILES = 50;

  const contextBatches: FileMap[] =
    filteredFiles && Object.keys(filteredFiles).length > MAX_CONTEXT_FILES
      ? chunkFileMap(filteredFiles, OPTIMAL_BATCH_SIZE)
      : filteredFiles
        ? [filteredFiles]
        : [undefined as any];

  const totalBatches = contextBatches.filter(Boolean).length || 1;
  const filteredFileCount = filteredFiles ? Object.keys(filteredFiles).length : 0;

  if (filteredFiles && filteredFileCount > MAX_CONTEXT_FILES) {
    const estimatedMinutes = Math.ceil((totalBatches * 10) / 60);
    const tooLargeWarning = filteredFileCount > MAX_RECOMMENDED_FILES
      ? ` This may take ~${estimatedMinutes} minute${estimatedMinutes !== 1 ? 's' : ''}. Consider narrowing your request to specific files or modules for faster results.`
      : '';

    writeDataPart(res, {
      type: "progress",
      label: "context",
      status: "in-progress",
      order: progressCounter++,
      message: `Processing ${filteredFileCount} files in ${totalBatches} batches of ${OPTIMAL_BATCH_SIZE}.${tooLargeWarning}`,
    } satisfies ProgressAnnotation);
  }

  writeDataPart(res, {
    type: "progress",
    label: "response",
    status: "in-progress",
    order: progressCounter++,
    message: "Generating Response",
  } satisfies ProgressAnnotation);

  const workingMessages = [...processedMessages];

  for (let batchIndex = 0; batchIndex < contextBatches.length; batchIndex++) {
    if (shouldAbort()) {
      logger.info(`[${requestId}] Client disconnected, aborting batch loop at batch ${batchIndex + 1}/${contextBatches.length}`);
      break;
    }

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

    let activeGuard: import("../llm/stream-recovery").StreamGuard | null = null;

    while (!done) {
      if (shouldAbort()) {
        logger.info(`[${requestId}] Client disconnected, aborting streaming loop`);
        activeGuard?.stop();
        activeGuard = null;
        break;
      }

      let finishReason: string | undefined;
      let finalText: string | undefined;
      let stepToolCalls: any[] = [];
      let stepToolResultsCount = 0;

      const guard = new StreamGuard({
        activityTimeoutMs: STREAM_ACTIVITY_TIMEOUT_MS,
        heartbeatIntervalMs: STREAM_HEARTBEAT_INTERVAL_MS,
        onDegraded: () => logger.warn(`[${requestId}] Stream degraded — no activity for 15s`),
        onStalled: () => logger.warn(`[${requestId}] Stream stalled — no activity for 30s`),
        onDead: () => logger.error(`[${requestId}] Stream dead — max retries exhausted`),
      });

      activeGuard = guard;
      guard.start();

      const options: StreamingOptions = {
        supabaseConnection: supabase,
        toolChoice: "auto",
        tools: mcpService.toolsWithoutExecute,
        maxSteps: maxLLMSteps,
        onStepFinish: ({ toolCalls, toolResults }: any) => {
          stepToolCalls = toolCalls || [];
          stepToolResultsCount = (toolResults || []).length;

          for (const toolCall of stepToolCalls) {
            mcpService.processToolCall(toolCall, dataStreamAdapter as any);
          }

          const signal = recovery.analyzeStep(stepToolCalls, stepToolResultsCount, finalText?.length);

          if (signal) {
            logger.warn(`[${requestId}] Recovery signal: ${signal.reason} (${signal.escalation}) — ${signal.message}`);

            writeDataPart(res, {
              type: "progress",
              label: "recovery",
              status: "in-progress",
              order: progressCounter++,
              message: signal.message,
            } satisfies ProgressAnnotation);

            if (signal.escalation === "finalize") {
              logger.warn(`[${requestId}] Escalation=finalize, forcing done`);
              finishReason = "stop";
              done = true;
            } else if (signal.injectedPrompt && signal.escalation === "redirect") {
              workingMessages.push({
                id: generateId(),
                role: "user",
                content: signal.injectedPrompt,
              } as any);
            }
          }
        },
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

      logger.info(`[${requestId}] streamText() batch=${batchNum}/${totalBatches} segment=${switches + 1}`);

      try {
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

        await pipeWebStreamToExpress({ requestId, res, webStream: response.body as any, guard });

        guard.stop();
        activeGuard = null;

        const m = guard.metrics();
        logger.info(`[${requestId}] Segment done: ${safeJson(m)}`);
      } catch (err: any) {
        guard.stop();
        activeGuard = null;

        const isTimeout = err?.name === "AbortError" || err?.message?.includes("timeout") || err?.message?.includes("timed out");

        if (isTimeout && guard.canRetry) {
          const signal = recovery.registerTimeout();
          const backoff = guard.consumeRetry();

          logger.warn(`[${requestId}] Stream timeout, retry in ${backoff}ms (${signal.escalation})`);

          writeDataPart(res, {
            type: "progress",
            label: "recovery",
            status: "in-progress",
            order: progressCounter++,
            message: `Stream timed out, retrying... (attempt ${guard.metrics().retries})`,
          } satisfies ProgressAnnotation);

          await new Promise((r) => setTimeout(r, backoff));

          if (signal.injectedPrompt && signal.escalation !== "nudge") {
            workingMessages.push({
              id: generateId(),
              role: "user",
              content: signal.injectedPrompt,
            } as any);
          }

          continue;
        }

        logger.error(`[${requestId}] Unrecoverable stream error: ${err?.message}`, err);
        throw err;
      }

      if (done) break;

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
        `[${requestId}] Max tokens reached (${MAX_TOKENS}). Continuing... (${switchesLeft} switches left)`,
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
  logger.info(`[${requestId}] Discuss streaming ended elapsedMs=${Date.now() - startedAt}`);
}

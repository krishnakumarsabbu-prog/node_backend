import type { Request, Response } from "express";
import { Readable } from "node:stream";
import { generateId } from "ai";

import { MAX_RESPONSE_SEGMENTS, MAX_TOKENS, type FileMap } from "../llm/constants";
import { streamText, type Messages, type StreamingOptions } from "../llm/stream-text";

import type { IProviderSetting } from "../types/model";
import type { DesignScheme } from "../types/design-scheme";
import { createScopedLogger } from "../utils/logger";

import { getFilePaths, searchContext } from "../llm/search-context";
import { createSummary } from "../llm/create-summary";
import { extractPropertiesFromMessage } from "../llm/utils";
import { WORK_DIR } from "../utils/constants";

import type { ContextAnnotation, ProgressAnnotation } from "../types/context";
import { MCPService } from "../llm/mcpService";
import { CONTINUE_PROMPT } from "../prompts/prompts";
import { ChatMigrationHandler } from "./chatMigration";
import { streamPlanResponse, StreamWriter } from "../llm/plan-processor";

const logger = createScopedLogger("api.chat");

type ChatRequestBody = {
  messages: Messages;
  files: any;
  promptId?: string;
  contextOptimization: boolean;
  chatMode: "discuss" | "build" | "migrate";
  designScheme?: DesignScheme;
  implementPlan: boolean;
  supabase?: {
    isConnected: boolean;
    hasSelectedProject: boolean;
    credentials?: { anonKey?: string; supabaseUrl?: string };
  };
  maxLLMSteps: number;

  apiKeys: Record<string, string>;
  providerSettings: Record<string, IProviderSetting>;

  migrationAction?: "plan" | "implement";
  migrationPlan?: any;
};

const MAX_CONTEXT_FILES = 5;

function setSSEHeaders(res: Response) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
}

function setCORS(req: Request, res: Response) {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
}

function safeJson(v: unknown) {
  try {
    return JSON.stringify(v);
  } catch {
    return '"[unserializable]"';
  }
}

function redact(obj: any) {
  if (!obj || typeof obj !== "object") return obj;
  const out: any = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    const lk = k.toLowerCase();
    if (
      lk.includes("key") ||
      lk.includes("token") ||
      lk.includes("secret") ||
      lk.includes("password") ||
      lk.includes("authorization") ||
      lk.includes("anonkey") ||
      lk.includes("apikey")
    ) {
      out[k] = "[REDACTED]";
    } else if (v && typeof v === "object") {
      out[k] = redact(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function summarizeMessages(messages: any[]) {
  const count = Array.isArray(messages) ? messages.length : 0;
  const roles: Record<string, number> = {};
  for (const m of messages || []) roles[m?.role || "unknown"] = (roles[m?.role || "unknown"] || 0) + 1;

  const first = messages?.[0];
  const last = messages?.[messages.length - 1];

  const pick = (m: any) => ({
    id: m?.id,
    role: m?.role,
    contentType: Array.isArray(m?.content) ? "array" : typeof m?.content,
    contentPreview: typeof m?.content === "string" ? m.content.slice(0, 200) : "",
    contentLength: typeof m?.content === "string" ? m.content.length : 0,
    partsCount: Array.isArray(m?.parts) ? m.parts.length : 0,
    attachmentsCount: Array.isArray(m?.experimental_attachments) ? m.experimental_attachments.length : 0,
  });

  return { count, roles, first: pick(first), last: pick(last) };
}

function summarizeFiles(files: any) {
  if (!files) return { present: false, count: 0 };
  if (typeof files !== "object") return { present: true, count: 0, note: "non-object" };
  const keys = Object.keys(files);
  return { present: true, count: keys.length, sample: keys.slice(0, 25) };
}

function writeDataPart(res: Response, data: unknown): boolean {
  try {
    if (res.writableEnded || res.destroyed) {
      logger.warn(`writeDataPart: Response already ended or destroyed, skipping write`);
      return false;
    }

    const dataArray = [data];
    const dataString = JSON.stringify(dataArray);
    logger.info(`writeDataPart dataString ${dataString.length}`);

    const maxSize = 100000;
    if (dataString.length > maxSize) {
      logger.warn(`writeDataPart: Data size exceeds limit (${dataString.length} > ${maxSize})`);
      const truncatedData = [{
        type: "warning",
        message: "Data size exceeded limit. Some data may be truncated.",
        originalSize: dataString.length,
      }];
      res.write(`2:${JSON.stringify(truncatedData)}\n`);
      return false;
    }

    const chunk = `2:${dataString}\n`;
    const writeResult = res.write(chunk);
    logger.info(`writeDataPart write result: ${writeResult}, chunk length: ${chunk.length}`);
    return writeResult;
  } catch (error: any) {
    logger.error("writeDataPart: Error writing data:", error);
    if (!res.writableEnded && !res.destroyed) {
      const errorData = [{
        type: "error",
        message: `Error processing data: ${error.message}`,
      }];
      res.write(`2:${JSON.stringify(errorData)}\n`);
    }
    return false;
  }
}

function writeMessageAnnotationPart(res: Response, annotation: unknown): boolean {
  try {
    if (res.writableEnded || res.destroyed) {
      logger.warn(`writeMessageAnnotationPart: Response already ended or destroyed, skipping write`);
      return false;
    }

    const annotationArray = [annotation];
    const annotationString = JSON.stringify(annotationArray);
    logger.info(`writeMessageAnnotationPart dataString ${annotationString.length}`);
    const writeResult = res.write(`8:${annotationString}\n`);
    logger.info(`writeMessageAnnotationPart write result: ${writeResult}`);
    return writeResult;
  } catch (error: any) {
    logger.error("writeMessageAnnotationPart: Error writing data:", error);
    return false;
  }
}

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

function normalizePathForUI(path: string) {
  let p = path;
  if (p.startsWith(WORK_DIR)) p = p.replace(WORK_DIR, "");
  return p;
}

/** Split a FileMap into batches of N entries, preserving insertion order */
function chunkFileMap(fileMap: FileMap, size: number): FileMap[] {
  const entries = Object.entries(fileMap || {});
  const batches: FileMap[] = [];
  for (let i = 0; i < entries.length; i += size) {
    const slice = entries.slice(i, i + size);
    batches.push(Object.fromEntries(slice));
  }
  return batches;
}

export async function chatHandler(req: Request, res: Response) {
  setCORS(req, res);

  const requestId = generateId();
  const startedAt = Date.now();

  req.setTimeout(30 * 60 * 1000);

  if (req.method === "OPTIONS") {
    logger.info(`[${requestId}] OPTIONS preflight`);
    res.status(204).end();
    return;
  }

  logger.info(
    `[${requestId}] ${req.method} ${req.originalUrl || req.url} ip=${req.ip || "unknown"} ua="${
      req.headers["user-agent"] || ""
    }"`,
  );

  try {
    const body = req.body as ChatRequestBody;

    if (!body) {
      logger.warn(`[${requestId}] Missing request body`);
      res.status(400).json({ error: true, message: "Missing request body", requestId });
      return;
    }

    const {
      messages,
      files,
      promptId,
      contextOptimization,
      supabase,
      chatMode,
      designScheme,
      implementPlan,
      maxLLMSteps,
      apiKeys,
      providerSettings,
      migrationAction,
      migrationPlan,
    } = body;

    if (!messages || !Array.isArray(messages)) {
      logger.warn(`[${requestId}] Invalid messages payload`);
      res.status(400).json({ error: true, message: "`messages` must be an array", requestId });
      return;
    }

    logger.info(
      `[${requestId}] Body summary: ${safeJson(
        redact({
          promptId: promptId || "default",
          contextOptimization: !!contextOptimization,
          chatMode,
          implementPlan: !!implementPlan,
          maxLLMSteps,
          supabase,
          files: summarizeFiles(files),
          messages: summarizeMessages(messages as any[]),
          apiKeys: apiKeys ? Object.keys(apiKeys) : [],
          providerSettings: providerSettings ? Object.keys(providerSettings) : [],
        }),
      )}`,
    );

    setSSEHeaders(res);

    let clientDisconnected = false;
    let responseFinished = false;

    res.on("close", () => {
      clientDisconnected = true;
      if (!responseFinished) {
        logger.warn(`[${requestId}] client disconnected before response finished`);
      } else {
        logger.info(`[${requestId}] client connection closed (normal)`);
      }
    });

    res.on("finish", () => {
      responseFinished = true;
      logger.info(`[${requestId}] response finished elapsedMs=${Date.now() - startedAt}`);
    });

    const shouldAbort = () => clientDisconnected || res.writableEnded || res.destroyed;

    const cumulativeUsage = { completionTokens: 0, promptTokens: 0, totalTokens: 0 };
    let progressCounter = 1;

    const dataStreamAdapter = {
      writeData: (data: unknown) => {
        logger.info(`[${requestId}] Calling writeData`);
        writeDataPart(res, data);
      },
      writeMessageAnnotation: (ann: unknown) => {
        logger.info(`[${requestId}] Calling writeMessageAnnotation`);
        writeMessageAnnotationPart(res, ann);
      },
    };

    // --- Migration mode ---
    if (chatMode === "migrate") {
      logger.info(`[${requestId}] Migration mode: action=${migrationAction || "plan"}`);

      const migrationHandler = new ChatMigrationHandler(WORK_DIR, false);

      try {
        if (migrationAction === "implement" && migrationPlan) {
          progressCounter = await migrationHandler.handlePlanExecution(
            {
              files: files as FileMap,
              messages,
              workDir: WORK_DIR,
              migrationAction,
              migrationPlan,
            },
            writeDataPart,
            writeMessageAnnotationPart,
            res,
            progressCounter
          );
        } else {
          progressCounter = await migrationHandler.handlePlanGeneration(
            {
              files: files as FileMap,
              messages,
              workDir: WORK_DIR,
            },
            writeDataPart,
            writeMessageAnnotationPart,
            res,
            progressCounter
          );
        }

        res.end();
        logger.info(`[${requestId}] Migration complete elapsedMs=${Date.now() - startedAt}`);
        return;
      } catch (error) {
        logger.error(`[${requestId}] Migration failed: ${(error as Error).message}`);
        res.end();
        return;
      }
    }

    const mcpService = MCPService.getInstance();
    const totalMessageContent = (messages as any[]).reduce((acc, m) => acc + (m?.content || ""), "");
    logger.info(`[${requestId}] Total message length: ${String(totalMessageContent).split(" ").length} words`);

    logger.info(`[${requestId}] Processing tool invocations...`);
    const mcpStart = Date.now();
    const processedMessages = await mcpService.processToolInvocations(messages, dataStreamAdapter as any);
    logger.info(`[${requestId}] Tool invocations processed in ${Date.now() - mcpStart}ms`);

    let messageSliceId = 0;
    if (processedMessages.length > 3) messageSliceId = processedMessages.length - 3;

    const filePaths = getFilePaths(files || {});
    let filteredFiles: FileMap | undefined = undefined;
    let summary: string | undefined = undefined;

    logger.info(`[${requestId}] filePaths.length before context selection: ${safeJson(filePaths)}`);

    if (filePaths.length > 0 && contextOptimization) {
      if (shouldAbort()) {
        logger.info(`[${requestId}] Client disconnected before context selection, aborting`);
        return;
      }

      logger.info(`[${requestId}] Generating Chat Summary`);
      writeDataPart(res, {
        type: "progress",
        label: "summary",
        status: "in-progress",
        order: progressCounter++,
        message: "Analysing Request",
      } satisfies ProgressAnnotation);

      summary = await createSummary({
        messages: [...processedMessages],
        onFinish(resp: any) {
          if (resp?.usage) {
            logger.info(`[${requestId}] createSummary token usage ${safeJson(resp.usage)}`);
            cumulativeUsage.completionTokens += resp.usage.completionTokens || 0;
            cumulativeUsage.promptTokens += resp.usage.promptTokens || 0;
            cumulativeUsage.totalTokens += resp.usage.totalTokens || 0;
          }
        },
      });

      if (shouldAbort()) {
        logger.info(`[${requestId}] Client disconnected during createSummary, aborting`);
        return;
      }

      writeDataPart(res, {
        type: "progress",
        label: "summary",
        status: "complete",
        order: progressCounter++,
        message: "Analysis Complete",
      } satisfies ProgressAnnotation);

      writeMessageAnnotationPart(res, {
        type: "chatSummary",
        summary,
        chatId: processedMessages.slice(-1)?.[0]?.id,
      } as ContextAnnotation);

      logger.info(`[${requestId}] Updating Context Buffer`);
      writeDataPart(res, {
        type: "progress",
        label: "context",
        status: "in-progress",
        order: progressCounter++,
        message: "Determining Files to Read",
      } satisfies ProgressAnnotation);

      filteredFiles = await searchContext({
        messages: [...processedMessages],
        files,
        summary,
        onFinish(resp: any) {
          if (resp?.usage) {
            logger.info(`[${requestId}] selectContext fallback token usage ${safeJson(resp.usage)}`);
            cumulativeUsage.completionTokens += resp.usage.completionTokens || 0;
            cumulativeUsage.promptTokens += resp.usage.promptTokens || 0;
            cumulativeUsage.totalTokens += resp.usage.totalTokens || 0;
          }
        },
      });

      if (shouldAbort()) {
        logger.info(`[${requestId}] Client disconnected during searchContext, aborting`);
        return;
      }

      if (filteredFiles) {
        logger.info(`[${requestId}] files in context: ${safeJson(Object.keys(filteredFiles))}`);
      }

      writeMessageAnnotationPart(res, {
        type: "codeContext",
        files: Object.keys(filteredFiles || {}).map(normalizePathForUI),
      } as ContextAnnotation);

      writeDataPart(res, {
        type: "progress",
        label: "context",
        status: "complete",
        order: progressCounter++,
        message: "Code Files Selected",
      } satisfies ProgressAnnotation);
    }

    // --- Plan Implementation Mode (implementPlan === true) ---
    // PLAN.md in 'files' is read, parsed by the LLM into structured steps,
    // then each step is streamed one-by-one.
    if (implementPlan) {
      if (shouldAbort()) {
        logger.info(`[${requestId}] Client disconnected before plan execution, aborting`);
        return;
      }

      logger.info(`[${requestId}] implementPlan=true starting PLAN.md-driven streaming`);

      const planWriter: StreamWriter = {
        writeData: (data: unknown) => writeDataPart(res, data),
        writeAnnotation: (ann: unknown) => writeMessageAnnotationPart(res, ann),
        isAlive: () => !shouldAbort(),
      };

      const planProgressCounter = { value: progressCounter };

      const planStreamingOptions: StreamingOptions = {
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

      await streamPlanResponse({
        res,
        requestId,
        messages: [...processedMessages],
        files: (files || {}) as any,
        streamingOptions: planStreamingOptions,
        apiKeys,
        providerSettings,
        promptId: promptId || "default",
        chatMode: chatMode as "discuss" | "build",
        designScheme,
        summary,
        progressCounter: planProgressCounter,
        writer: planWriter,
        cumulativeUsage,
      });

      progressCounter = planProgressCounter.value;

      writeMessageAnnotationPart(res, {
        type: "usage",
        value: {
          completionTokens: cumulativeUsage.completionTokens,
          promptTokens: cumulativeUsage.promptTokens,
          totalTokens: cumulativeUsage.totalTokens,
        },
      });

      const planDFrame = {
        finishReason: "stop",
        usage: {
          promptTokens: cumulativeUsage.promptTokens,
          completionTokens: cumulativeUsage.completionTokens,
        },
      };
      res.write(`d:${JSON.stringify(planDFrame)}\n`);
      logger.info(`[${requestId}] Emitted final d: frame`);

      res.end();
      logger.info(`[${requestId}] Plan streaming ended elapsedMs=${Date.now() - startedAt}`);
      return;
    }

    // --- Build mode: auto-planning from user question ---
    if (chatMode === "build") {
      const lastUserMsg = [...processedMessages].reverse().find((m: any) => m.role === "user");
      const userQuestion = lastUserMsg
        ? typeof lastUserMsg.content === "string"
          ? lastUserMsg.content
          : Array.isArray(lastUserMsg.content)
            ? (lastUserMsg.content as any[])
                .filter((p: any) => p.type === "text")
                .map((p: any) => p.text)
                .join(" ")
            : ""
        : "";

      if (userQuestion && !shouldAbort()) {
        logger.info(`[${requestId}] Build mode auto-planning from question: "${userQuestion.substring(0, 80)}"`);

        const planWriter: StreamWriter = {
          writeData: (data: unknown) => writeDataPart(res, data),
          writeAnnotation: (ann: unknown) => writeMessageAnnotationPart(res, ann),
          isAlive: () => !shouldAbort(),
        };

        const planProgressCounter = { value: progressCounter };

        const planStreamingOptions: StreamingOptions = {
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

        await streamPlanResponse({
          res,
          requestId,
          messages: [...processedMessages],
          files: (files || {}) as any,
          userQuestion,
          streamingOptions: planStreamingOptions,
          apiKeys,
          providerSettings,
          promptId: promptId || "default",
          chatMode: chatMode as "discuss" | "build",
          designScheme,
          summary,
          progressCounter: planProgressCounter,
          writer: planWriter,
          cumulativeUsage,
        });

        progressCounter = planProgressCounter.value;

        writeMessageAnnotationPart(res, {
          type: "usage",
          value: {
            completionTokens: cumulativeUsage.completionTokens,
            promptTokens: cumulativeUsage.promptTokens,
            totalTokens: cumulativeUsage.totalTokens,
          },
        });

        const buildDFrame = {
          finishReason: "stop",
          usage: {
            promptTokens: cumulativeUsage.promptTokens,
            completionTokens: cumulativeUsage.completionTokens,
          },
        };
        res.write(`d:${JSON.stringify(buildDFrame)}\n`);
        logger.info(`[${requestId}] Emitted final d: frame`);

        res.end();
        logger.info(`[${requestId}] Build-mode plan streaming ended elapsedMs=${Date.now() - startedAt}`);
        return;
      }
    }

    // --- Normal (discuss / fallback) processing with file batching ---
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

    res.end();
    logger.info(`[${requestId}] Streaming ended elapsedMs=${Date.now() - startedAt}`);
  } catch (error: any) {
    logger.error(`[${requestId}] Handler error: ${error?.message || error}`, error);

    if (res.headersSent) {
      try {
        writeDataPart(res, { type: "error", message: error?.message || "Internal server error" });
      } catch {}
      res.end();
      return;
    }

    res.status(500).json({
      error: true,
      message: error?.message || "Internal server error",
      requestId,
    });
  }
}

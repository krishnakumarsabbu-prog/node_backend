import type { Request, Response } from "express";
import { Readable } from "node:stream";
import { generateId } from "ai";

import { MAX_RESPONSE_SEGMENTS, MAX_TOKENS, type FileMap } from "../llm/constants";
import { streamText, type Messages, type StreamingOptions } from "../llm/stream-text";

import type { IProviderSetting } from "../types/model";
import type { DesignScheme } from "../types/design-scheme";
import { createScopedLogger } from "../utils/logger";

import { getFilePaths, selectContext } from "../llm/select-context";
import { createSummary } from "../llm/create-summary";
import { extractPropertiesFromMessage } from "../llm/utils";
import { WORK_DIR } from "../utils/constants";

import type { ContextAnnotation, ProgressAnnotation } from "../types/context";
import { MCPService } from "../llm/mcpService";
import { StreamRecoveryManager } from "../llm/stream-recovery";
import { CONTINUE_PROMPT } from "../prompts/prompts";
import { analyzeProjectForMigration } from "../llm/migration/migrationAnalyzer";
import { generateMigrationPlan } from "../llm/migration/migrationPlanner";
import { executeMigrationPlan } from "../llm/migration/migrationExecutor";
import type { MigrationPlan } from "../llm/migration/migrationTypes";

const logger = createScopedLogger("api.chat");

type ChatRequestBody = {
  messages: Messages;
  files: any;
  promptId?: string;
  contextOptimization: boolean;
  chatMode: "discuss" | "build" | "migrate";
  designScheme?: DesignScheme;
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
  res.setHeader("Cache-Control", "no-cache");
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

function writeDataPart(res: Response, data: unknown) {
  res.write(`2:${JSON.stringify(data)}\n`);
}

function writeMessageAnnotationPart(res: Response, annotation: unknown) {
  res.write(`8:${JSON.stringify(annotation)}\n`);
}

async function pipeWebStreamToExpress(opts: {
  requestId: string;
  res: Response;
  webStream: ReadableStream;
  streamRecovery?: StreamRecoveryManager;
}) {
  const { requestId, res, webStream, streamRecovery } = opts;

  const nodeStream = Readable.fromWeb(webStream as any);

  return new Promise<void>((resolve, reject) => {
    nodeStream.on("data", () => {
      streamRecovery?.updateActivity?.();
    });

    nodeStream.on("error", (err) => {
      logger.error(`[${requestId}] nodeStream error: ${err?.message || err}`, err);
      reject(err);
    });

    nodeStream.on("end", () => resolve());

    nodeStream.pipe(res, { end: false });
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

  const streamRecovery = new StreamRecoveryManager({
    timeout: 45000,
    maxRetries: 2,
    onTimeout: () => {
      logger.warn(`[${requestId}] Stream timeout - attempting recovery`);
    },
  });

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

    res.on("close", () => logger.warn(`[${requestId}] client disconnected`));
    res.on("finish", () => logger.info(`[${requestId}] response finished elapsedMs=${Date.now() - startedAt}`));

    const cumulativeUsage = { completionTokens: 0, promptTokens: 0, totalTokens: 0 };
    let progressCounter = 1;

    if (chatMode === "migrate") {
      logger.info(`[${requestId}] Migration mode: action=${migrationAction || "plan"}`);

      if (migrationAction === "implement" && migrationPlan) {
        writeDataPart(res, {
          type: "progress",
          label: "migration",
          status: "in-progress",
          order: progressCounter++,
          message: "Executing migration tasks",
        } satisfies ProgressAnnotation);

        const result = await executeMigrationPlan(migrationPlan as MigrationPlan, files as FileMap);

        writeDataPart(res, {
          type: "progress",
          label: "migration",
          status: "complete",
          order: progressCounter++,
          message: "Migration completed",
        } satisfies ProgressAnnotation);

        writeMessageAnnotationPart(res, {
          type: "migration_result",
          result: {
            filesModified: result.filesModified,
            filesCreated: result.filesCreated,
            filesDeleted: result.filesDeleted,
            modifiedFiles: result.modifiedFiles,
            createdFiles: result.createdFiles,
            deletedFiles: result.deletedFiles,
          },
        } as ContextAnnotation);

        res.end();
        logger.info(`[${requestId}] Migration execution complete elapsedMs=${Date.now() - startedAt}`);
        return;
      }

      writeDataPart(res, {
        type: "progress",
        label: "migration",
        status: "in-progress",
        order: progressCounter++,
        message: "Analyzing project",
      } satisfies ProgressAnnotation);

      const analysis = await analyzeProjectForMigration(files as FileMap);

      writeDataPart(res, {
        type: "progress",
        label: "migration",
        status: "complete",
        order: progressCounter++,
        message: "Project analysis complete",
      } satisfies ProgressAnnotation);

      writeDataPart(res, {
        type: "progress",
        label: "migration",
        status: "in-progress",
        order: progressCounter++,
        message: "Generating migration plan",
      } satisfies ProgressAnnotation);

      const plan = await generateMigrationPlan(files as FileMap, messages, analysis);

      writeDataPart(res, {
        type: "progress",
        label: "migration",
        status: "complete",
        order: progressCounter++,
        message: "Migration plan generated",
      } satisfies ProgressAnnotation);

      writeMessageAnnotationPart(res, {
        type: "migration_plan",
        plan,
      } as ContextAnnotation);

      res.end();
      logger.info(`[${requestId}] Migration planning complete elapsedMs=${Date.now() - startedAt}`);
      return;
    }

    const dataStreamAdapter = {
      writeData: (data: unknown) => writeDataPart(res, data),
      writeMessageAnnotation: (ann: unknown) => writeMessageAnnotationPart(res, ann),
    };

    const mcpService = MCPService.getInstance();

    const processedMessages = await mcpService.processToolInvocations(messages, dataStreamAdapter as any);

    let messageSliceId = 0;
    if (processedMessages.length > 3) messageSliceId = processedMessages.length - 3;

    const filePaths = getFilePaths(files || {});
    let filteredFiles: FileMap | undefined = undefined;
    let summary: string | undefined = undefined;

    if (filePaths.length > 0 && contextOptimization) {
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
            cumulativeUsage.completionTokens += resp.usage.completionTokens || 0;
            cumulativeUsage.promptTokens += resp.usage.promptTokens || 0;
            cumulativeUsage.totalTokens += resp.usage.totalTokens || 0;
          }
        },
      });

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

      writeDataPart(res, {
        type: "progress",
        label: "context",
        status: "in-progress",
        order: progressCounter++,
        message: "Determining Files to Read",
      } satisfies ProgressAnnotation);

      filteredFiles = await selectContext({
        messages: [...processedMessages],
        files,
        summary,
        onFinish(resp: any) {
          if (resp?.usage) {
            cumulativeUsage.completionTokens += resp.usage.completionTokens || 0;
            cumulativeUsage.promptTokens += resp.usage.promptTokens || 0;
            cumulativeUsage.totalTokens += resp.usage.totalTokens || 0;
          }
        },
      });

      writeDataPart(res, {
        type: "progress",
        label: "context",
        status: "complete",
        order: progressCounter++,
        message: "Code Files Selected",
      } satisfies ProgressAnnotation);
    }

    // ---- NEW: Build context batches (<=5 per batch) ----
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

    // Write "Generating Response" progress
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

    // We mutate this message array like Remix does
    const workingMessages = [...processedMessages];

    // ---- NEW: run streamText per batch, sequentially, within same SSE ----
    for (let batchIndex = 0; batchIndex < contextBatches.length; batchIndex++) {
      const batchFiles = contextBatches[batchIndex];
      const batchNum = batchIndex + 1;

      // Update UI about which files are in context for THIS batch
      if (batchFiles) {
        writeMessageAnnotationPart(res, {
          type: "codeContext",
          files: Object.keys(batchFiles).map(normalizePathForUI),
        } as ContextAnnotation);
      }

      // Optional but VERY helpful: tell the model this is batch i/n
      if (batchIndex > 0) {
        workingMessages.push({
          id: generateId(),
          role: "user",
          content: `We are continuing the same task, but now processing the next subset of files (batch ${batchNum}/${totalBatches}). Use ONLY the files in the current context buffer. Continue from where you left off and avoid repeating previous output.`,
        } as any);
      }

      // Per-batch continuation loop (finishReason === 'length')
      let switches = 0;
      let done = false;

      while (!done) {
        streamRecovery.startMonitoring();

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
          contextFiles: batchFiles, // ✅ IMPORTANT: per-batch 5-file context
          chatMode,
          designScheme,
          summary,
          messageSliceId,
        });

        const response = result.toDataStreamResponse();

        if (!response.body) {
          streamRecovery.stop();
          throw new Error("toDataStreamResponse() returned empty body");
        }

        await pipeWebStreamToExpress({
          requestId,
          res,
          webStream: response.body as any,
          streamRecovery,
        });

        streamRecovery.stop();

        // Finished normally for this segment
        if (finishReason !== "length") {
          done = true;
          break;
        }

        // length -> continue (same as your logic)
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

      // Per-batch progress marker (optional UI candy)
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

    // Final usage + completion
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
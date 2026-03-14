import type { Request, Response } from "express";
import { generateId } from "ai";
import { createScopedLogger } from "../utils/logger";
import { WORK_DIR } from "../utils/constants";
import type { FileMap } from "../llm/constants";
import type { Messages, StreamingOptions } from "../llm/stream-text";
import type { IProviderSetting } from "../types/model";
import type { DesignScheme } from "../types/design-scheme";
import type { ContextAnnotation, ProgressAnnotation } from "../types/context";
import { MCPService } from "../llm/mcpService";

export const logger = createScopedLogger("api.chat");

export type ChatRequestBody = {
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

export const MAX_CONTEXT_FILES = 5;

export function setSSEHeaders(res: Response) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
}

export function setCORS(req: Request, res: Response) {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
}

export function safeJson(v: unknown) {
  try {
    return JSON.stringify(v);
  } catch {
    return '"[unserializable]"';
  }
}

export function redact(obj: any) {
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

export function summarizeMessages(messages: any[]) {
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

export function summarizeFiles(files: any) {
  if (!files) return { present: false, count: 0 };
  if (typeof files !== "object") return { present: true, count: 0, note: "non-object" };
  const keys = Object.keys(files);
  return { present: true, count: keys.length, sample: keys.slice(0, 25) };
}

export function writeDataPart(res: Response, data: unknown): boolean {
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

export function writeMessageAnnotationPart(res: Response, annotation: unknown): boolean {
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

export function normalizePathForUI(path: string) {
  let p = path;
  if (p.startsWith(WORK_DIR)) p = p.replace(WORK_DIR, "");
  return p;
}

export function chunkFileMap(fileMap: FileMap, size: number): FileMap[] {
  const entries = Object.entries(fileMap || {});
  const batches: FileMap[] = [];
  for (let i = 0; i < entries.length; i += size) {
    const slice = entries.slice(i, i + size);
    batches.push(Object.fromEntries(slice));
  }
  return batches;
}

export interface ChatContext {
  requestId: string;
  startedAt: number;
  body: ChatRequestBody;
  shouldAbort: () => boolean;
  abortController: AbortController;
  cumulativeUsage: { completionTokens: number; promptTokens: number; totalTokens: number };
  progressCounter: number;
  dataStreamAdapter: {
    writeData: (data: unknown) => void;
    writeMessageAnnotation: (ann: unknown) => void;
  };
}

export async function buildChatContext(req: Request, res: Response): Promise<ChatContext | null> {
  setCORS(req, res);

  const requestId = generateId();
  const startedAt = Date.now();

  req.setTimeout(30 * 60 * 1000);

  if (req.method === "OPTIONS") {
    logger.info(`[${requestId}] OPTIONS preflight`);
    res.status(204).end();
    return null;
  }

  logger.info(
    `[${requestId}] ${req.method} ${req.originalUrl || req.url} ip=${req.ip || "unknown"} ua="${
      req.headers["user-agent"] || ""
    }"`,
  );

  const body = req.body as ChatRequestBody;

  if (!body) {
    logger.warn(`[${requestId}] Missing request body`);
    res.status(400).json({ error: true, message: "Missing request body", requestId });
    return null;
  }

  if (!body.messages || !Array.isArray(body.messages)) {
    logger.warn(`[${requestId}] Invalid messages payload`);
    res.status(400).json({ error: true, message: "`messages` must be an array", requestId });
    return null;
  }

  const lastUserMessage = (body.messages as any[]).filter((m) => m?.role === 'user').slice(-1)[0];
  const lastContent = typeof lastUserMessage?.content === 'string'
    ? lastUserMessage.content
    : Array.isArray(lastUserMessage?.content)
      ? lastUserMessage.content.map((p: any) => p?.text || '').join('')
      : '';

  if (!lastContent.trim()) {
    logger.warn(`[${requestId}] Empty user message rejected`);
    res.status(400).json({ error: true, message: "Message content cannot be empty", requestId });
    return null;
  }

  logger.info(
    `[${requestId}] Body summary: ${safeJson(
      redact({
        promptId: body.promptId || "default",
        contextOptimization: !!body.contextOptimization,
        chatMode: body.chatMode,
        implementPlan: !!body.implementPlan,
        maxLLMSteps: body.maxLLMSteps,
        supabase: body.supabase,
        files: summarizeFiles(body.files),
        messages: summarizeMessages(body.messages as any[]),
        apiKeys: body.apiKeys ? Object.keys(body.apiKeys) : [],
        providerSettings: body.providerSettings ? Object.keys(body.providerSettings) : [],
      }),
    )}`,
  );

  setSSEHeaders(res);

  let clientDisconnected = false;
  let responseFinished = false;

  const abortController = new AbortController();

  res.on("close", () => {
    clientDisconnected = true;
    if (!responseFinished) {
      logger.warn(`[${requestId}] client disconnected before response finished`);
      abortController.abort();
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

  return {
    requestId,
    startedAt,
    body,
    shouldAbort,
    abortController,
    cumulativeUsage,
    progressCounter: 1,
    dataStreamAdapter,
  };
}

export async function runContextOptimization(
  ctx: ChatContext,
  res: Response,
  processedMessages: Messages,
  files: FileMap,
): Promise<{ filteredFiles: FileMap | undefined; summary: string | undefined; messageSliceId: number }> {
  const { requestId, shouldAbort, cumulativeUsage } = ctx;
  let { progressCounter } = ctx;

  const { getFilePaths, searchContext } = await import("../llm/search-context");
  const { createSummary } = await import("../llm/create-summary");

  const filePaths = getFilePaths(files || {});
  let filteredFiles: FileMap | undefined = undefined;
  let summary: string | undefined = undefined;
  let messageSliceId = 0;

  if (processedMessages.length > 3) messageSliceId = processedMessages.length - 3;

  if (filePaths.length > 0 && ctx.body.contextOptimization) {
    if (shouldAbort()) return { filteredFiles, summary, messageSliceId };

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
          cumulativeUsage.completionTokens += resp.usage.completionTokens || 0;
          cumulativeUsage.promptTokens += resp.usage.promptTokens || 0;
          cumulativeUsage.totalTokens += resp.usage.totalTokens || 0;
        }
      },
    });

    if (shouldAbort()) return { filteredFiles, summary, messageSliceId };

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
          cumulativeUsage.completionTokens += resp.usage.completionTokens || 0;
          cumulativeUsage.promptTokens += resp.usage.promptTokens || 0;
          cumulativeUsage.totalTokens += resp.usage.totalTokens || 0;
        }
      },
    });

    if (shouldAbort()) return { filteredFiles, summary, messageSliceId };

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

  ctx.progressCounter = progressCounter;
  return { filteredFiles, summary, messageSliceId };
}

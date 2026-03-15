import type { Request, Response } from "express";
import { createHash } from "crypto";

import { MCPService } from "../llm/mcpService";
import type { FileMap } from "../llm/constants";

import {
  logger,
  safeJson,
  buildChatContext,
  runContextOptimization,
  writeDataPart,
} from "./chat-shared";
import { handleDiscuss } from "./chat-discuss";
import { handleBuild } from "./chat-build";
import { handleMigrate } from "./chat-migrate";

const inFlightRequests = new Map<string, { requestId: string; abort: () => void }>();

function getDedupeKey(body: any): string | null {
  if (!body?.messages?.length) return null;

  const fingerprint = (body.messages as any[])
    .map((m: any) => {
      const role = m?.role ?? '';
      const content = typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '');
      return `${role}:${content}`;
    })
    .join('\n');

  const filesKey = body.files ? Object.keys(body.files).sort().join(',') : '';
  const raw = `${body.chatMode || 'discuss'}::${filesKey}::${fingerprint}`;
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  return hash;
}

export async function chatHandler(req: Request, res: Response) {
  const ctx = await buildChatContext(req, res);
  if (!ctx) return;

  const { requestId, body, abortController } = ctx;
  const { messages, files, chatMode, implementPlan } = body;

  const dedupeKey = getDedupeKey(body);
  if (dedupeKey) {
    const existing = inFlightRequests.get(dedupeKey);
    if (existing) {
      logger.warn(`[${requestId}] Duplicate request detected (key: ${dedupeKey.slice(0, 60)}...), aborting previous [${existing.requestId}]`);
      existing.abort();
    }
    inFlightRequests.set(dedupeKey, { requestId, abort: () => abortController.abort() });
  }

  try {
    if (chatMode === "migrate") {
      await handleMigrate(ctx, res);
      return;
    }

    const mcpService = MCPService.getInstance();
    const totalMessageContent = (messages as any[]).reduce((acc, m) => acc + (m?.content || ""), "");
    logger.info(`[${requestId}] Total message length: ${String(totalMessageContent).split(" ").length} words`);

    logger.info(`[${requestId}] Processing tool invocations...`);
    const mcpStart = Date.now();
    const processedMessages = await mcpService.processToolInvocations(messages, ctx.dataStreamAdapter as any);
    logger.info(`[${requestId}] Tool invocations processed in ${Date.now() - mcpStart}ms`);

    const { filteredFiles, summary, messageSliceId } = await runContextOptimization(
      ctx,
      res,
      processedMessages,
      files as FileMap,
    );

    if (ctx.shouldAbort()) {
      logger.info(`[${requestId}] Client disconnected after context optimization, aborting`);
      return;
    }

    if (implementPlan || chatMode === "build") {
      await handleBuild(ctx, res, processedMessages, filteredFiles, summary);
    } else {
      await handleDiscuss(ctx, res, processedMessages, filteredFiles, summary, messageSliceId);
    }
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
  } finally {
    if (dedupeKey && inFlightRequests.get(dedupeKey)?.requestId === requestId) {
      inFlightRequests.delete(dedupeKey);
    }
  }
}

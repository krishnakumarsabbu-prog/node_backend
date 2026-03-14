import type { Request, Response } from "express";

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

const inFlightRequests = new Map<string, { startedAt: number; abort: () => void }>();

function getDedupeKey(body: any): string | null {
  if (!body?.messages?.length) return null;
  const last = body.messages[body.messages.length - 1];
  const content = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content);
  return `${body.chatMode || 'discuss'}::${content?.slice(0, 200)}`;
}

export async function chatHandler(req: Request, res: Response) {
  const ctx = await buildChatContext(req, res);
  if (!ctx) return;

  const { requestId, body, abortController } = ctx;
  const { messages, files, chatMode, implementPlan } = body;

  const dedupeKey = getDedupeKey(body);
  if (dedupeKey) {
    const existing = inFlightRequests.get(dedupeKey);
    if (existing && Date.now() - existing.startedAt < 3000) {
      logger.warn(`[${requestId}] Duplicate request detected (key: ${dedupeKey.slice(0, 60)}...), aborting previous`);
      existing.abort();
    }
    inFlightRequests.set(dedupeKey, { startedAt: Date.now(), abort: () => abortController.abort() });
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
    if (dedupeKey && inFlightRequests.get(dedupeKey)?.startedAt === ctx.startedAt) {
      inFlightRequests.delete(dedupeKey);
    }
  }
}

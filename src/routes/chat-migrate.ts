import type { Response } from "express";

import type { FileMap } from "../llm/constants";
import type { Messages, StreamingOptions } from "../llm/stream-text";
import { MCPService } from "../llm/mcpService";
import { ChatMigrationHandler } from "./chatMigration";
import { WORK_DIR } from "../utils/constants";

import {
  logger,
  writeDataPart,
  writeMessageAnnotationPart,
  type ChatContext,
} from "./chat-shared";

export async function handleMigrate(
  ctx: ChatContext,
  res: Response,
): Promise<void> {
  const {
    requestId,
    startedAt,
    body,
  } = ctx;
  let { progressCounter } = ctx;
  const {
    messages,
    files,
    supabase,
    maxLLMSteps,
    apiKeys,
    providerSettings,
    migrationAction,
    migrationPlan,
  } = body;

  logger.info(`[${requestId}] Migration mode: action=${migrationAction || "plan"}`);

  const migrationHandler = new ChatMigrationHandler(WORK_DIR, false);
  const migrationMcpService = MCPService.getInstance();

  try {
    if (migrationAction === "implement" && migrationPlan) {
      const migrationStreamingOptions: StreamingOptions = {
        toolChoice: "auto" as const,
        tools: migrationMcpService.toolsWithoutExecute,
        maxSteps: maxLLMSteps,
        supabaseConnection: supabase,
      };

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
        progressCounter,
        apiKeys,
        providerSettings,
        migrationStreamingOptions,
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
        progressCounter,
      );
    }

    ctx.progressCounter = progressCounter;
    res.end();
    logger.info(`[${requestId}] Migration complete elapsedMs=${Date.now() - startedAt}`);
  } catch (error) {
    logger.error(`[${requestId}] Migration failed: ${(error as Error).message}`);
    res.end();
  }
}

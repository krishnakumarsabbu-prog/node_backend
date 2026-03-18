import type { Response } from "express";

import type { FileMap } from "../llm/constants";
import type { Messages, StreamingOptions } from "../llm/stream-text";
import type { ProgressAnnotation } from "../types/context";
import { MCPService } from "../llm/mcpService";
import { streamPlanResponse, type StreamWriter } from "../llm/plan-processor";

import {
  logger,
  writeDataPart,
  writeMessageAnnotationPart,
  type ChatContext,
} from "./chat-shared";

export async function handleBuild(
  ctx: ChatContext,
  res: Response,
  processedMessages: Messages,
  filteredFiles: FileMap | undefined,
  summary: string | undefined,
): Promise<void> {
  const {
    requestId,
    startedAt,
    body,
    shouldAbort,
    abortController,
    cumulativeUsage,
    dataStreamAdapter,
  } = ctx;
  let { progressCounter } = ctx;
  const {
    files,
    chatMode,
    designScheme,
    supabase,
    maxLLMSteps,
    apiKeys,
    providerSettings,
    implementPlan,
  } = body;

  const mcpService = MCPService.getInstance();

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

  let userQuestion: string | undefined;

  if (!implementPlan) {
    const lastUserMsg = [...processedMessages].reverse().find((m: any) => m.role === "user");
    userQuestion = lastUserMsg
      ? typeof lastUserMsg.content === "string"
        ? lastUserMsg.content
        : Array.isArray(lastUserMsg.content)
          ? (lastUserMsg.content as any[])
              .filter((p: any) => p.type === "text")
              .map((p: any) => p.text)
              .join(" ")
          : ""
      : "";
  }

  if (implementPlan) {
    if (shouldAbort()) return;
    logger.info(`[${requestId}] implementPlan=true starting PLAN.md-driven streaming`);
  } else {
    if (shouldAbort()) return;
    if (!userQuestion) {
      logger.warn(`[${requestId}] Build mode called with no user question and no implementPlan flag — sending error response`);
      writeDataPart(res, {
        type: "error",
        error: "No question provided. Please describe what you would like to build or change.",
      });
      res.write(`d:${JSON.stringify({ finishReason: "error", usage: { promptTokens: 0, completionTokens: 0 } })}\n`);
      res.end();
      return;
    }
    logger.info(`[${requestId}] Build mode auto-planning from question: "${userQuestion.substring(0, 80)}"`);
  }

  await streamPlanResponse({
    res,
    requestId,
    messages: [...processedMessages],
    files: (files || {}) as any,
    userQuestion,
    implementPlan: !!implementPlan,
    streamingOptions: planStreamingOptions,
    apiKeys,
    providerSettings,
    chatMode: chatMode as "discuss" | "build",
    designScheme,
    summary,
    progressCounter: planProgressCounter,
    writer: planWriter,
    cumulativeUsage,
    clientAbortSignal: abortController.signal,
  });

  progressCounter = planProgressCounter.value;
  ctx.progressCounter = progressCounter;

  writeMessageAnnotationPart(res, {
    type: "usage",
    value: {
      completionTokens: cumulativeUsage.completionTokens,
      promptTokens: cumulativeUsage.promptTokens,
      totalTokens: cumulativeUsage.totalTokens,
    },
  });

  const dFrame = {
    finishReason: "stop",
    usage: {
      promptTokens: cumulativeUsage.promptTokens,
      completionTokens: cumulativeUsage.completionTokens,
    },
  };
  res.write(`d:${JSON.stringify(dFrame)}\n`);
  logger.info(`[${requestId}] Emitted final d: frame`);

  res.end();
  logger.info(`[${requestId}] Build streaming ended elapsedMs=${Date.now() - startedAt}`);
}

import { generateId } from "ai";
import { Readable } from "node:stream";
import type { Response } from "express";

import { createScopedLogger } from "../../utils/logger";
import { streamText, type Messages, type StreamingOptions } from "../stream-text";
import type { FileMap } from "../constants";
import type { IProviderSetting } from "../../types/model";
import type { DesignScheme } from "../../types/design-scheme";
import type { ProgressAnnotation } from "../../types/context";
import type { BatchPlan, BatchStep } from "./batch-types";
import type { StreamWriter } from "../plan-processor";

const logger = createScopedLogger("batch-executor");

const FRAME_RE = /^([0-9a-z]+):(.+)\n?$/;

async function pipeStepStream(
  requestId: string,
  res: Response,
  webStream: ReadableStream,
  stepIndex: number,
): Promise<void> {
  if (res.writableEnded || res.destroyed) {
    logger.warn(`[${requestId}] Response already ended before piping step ${stepIndex}`);
    return;
  }

  const nodeStream = Readable.fromWeb(webStream as any);
  let lineBuffer = "";

  function processLine(line: string): void {
    if (!line) return;

    const m = FRAME_RE.exec(line);
    if (m) {
      const prefix = m[1];

      if (prefix === "f" || prefix === "e" || prefix === "d" || prefix === "g") {
        return;
      }

      if (prefix === "3") {
        logger.warn(`[${requestId}] Step ${stepIndex} LLM error frame: ${m[2]}`);
        return;
      }
    }

    res.write(`${line}\n`);
  }

  nodeStream.on("data", (chunk: Buffer) => {
    const text = lineBuffer + chunk.toString("utf8");
    const lines = text.split("\n");
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) processLine(line);
  });

  return new Promise<void>((resolve, reject) => {
    nodeStream.on("end", () => {
      if (lineBuffer) processLine(lineBuffer);
      resolve();
    });
    nodeStream.on("error", (err: Error) => {
      logger.error(`[${requestId}] Step ${stepIndex} stream error: ${err.message}`);
      reject(err);
    });
  });
}

export interface BatchExecutorOptions {
  res: Response;
  requestId: string;
  messages: Messages;
  files: FileMap;
  plan: BatchPlan;
  streamingOptions: StreamingOptions;
  apiKeys: Record<string, string>;
  providerSettings: Record<string, IProviderSetting>;
  promptId: string;
  chatMode: "discuss" | "build";
  designScheme?: DesignScheme;
  summary?: string;
  progressCounter: { value: number };
  writer: StreamWriter;
  cumulativeUsage: {
    completionTokens: number;
    promptTokens: number;
    totalTokens: number;
  };
}

export async function executeBatchPlan(opts: BatchExecutorOptions): Promise<void> {
  const {
    res,
    requestId,
    messages,
    files,
    plan,
    streamingOptions,
    apiKeys,
    providerSettings,
    promptId,
    chatMode,
    designScheme,
    summary,
    progressCounter,
    writer,
    cumulativeUsage,
  } = opts;

  const { files: batchFiles, totalSteps, userIntent } = plan;

  if (totalSteps === 0) {
    writer.writeData({
      type: "progress",
      label: "batch-complete",
      status: "complete",
      order: progressCounter.value++,
      message: "No files identified for this request.",
    } satisfies ProgressAnnotation);
    return;
  }

  writer.writeData({
    type: "progress",
    label: "batch-start",
    status: "in-progress",
    order: progressCounter.value++,
    message: `Starting batch execution: ${totalSteps} file${totalSteps !== 1 ? "s" : ""} to process`,
  } satisfies ProgressAnnotation);

  writer.writeAnnotation({
    type: "batchPlan",
    files: batchFiles.map((f, i) => ({ stepIndex: i + 1, filePath: f.path, reason: f.reason })),
    totalSteps,
    userIntent,
  });

  const sharedMessageId = generateId();
  res.write(`f:${JSON.stringify({ messageId: sharedMessageId })}\n`);
  logger.info(`[${requestId}] Emitted shared messageId: ${sharedMessageId}`);

  let succeededSteps = 0;
  let failedSteps = 0;

  const allFilesList = batchFiles
    .map((f, i) => `  ${i + 1}. ${f.path}`)
    .join("\n");

  for (let i = 0; i < batchFiles.length; i++) {
    const batchFile = batchFiles[i];
    const stepIndex = i + 1;
    const step: BatchStep = {
      stepIndex,
      totalSteps,
      filePath: batchFile.path,
      reason: batchFile.reason,
    };

    if (!writer.isAlive()) {
      logger.warn(`[${requestId}] Client disconnected before step ${stepIndex}, aborting batch`);
      return;
    }

    logger.info(`[${requestId}] Batch step ${stepIndex}/${totalSteps}: ${step.filePath}`);

    writer.writeData({
      type: "progress",
      label: `batch-step-${stepIndex}`,
      status: "in-progress",
      order: progressCounter.value++,
      message: `Step ${stepIndex}/${totalSteps}: ${step.filePath}`,
    } satisfies ProgressAnnotation);

    const completedFiles = batchFiles
      .slice(0, i)
      .map((f) => `  - ${f.path}`)
      .join("\n");

    const remainingFiles = batchFiles
      .slice(i + 1)
      .map((f) => `  - ${f.path}`)
      .join("\n");

    const stepMessages: Messages = [...messages];

    const existingFile = files[step.filePath];
    const fileContext =
      existingFile && existingFile.type === "file" && !existingFile.isBinary
        ? `\n\nCurrent content of ${step.filePath}:\n\`\`\`\n${existingFile.content}\n\`\`\``
        : `\n\n${step.filePath} does not exist yet — create it from scratch.`;

    if (stepIndex > 1) {
      const prevFile = batchFiles[i - 1];
      stepMessages.push({
        id: generateId(),
        role: "assistant",
        content: `Step ${stepIndex - 1}/${totalSteps} complete: processed ${prevFile.path}.`,
      } as any);
    }

    stepMessages.push({
      id: generateId(),
      role: "user",
      content: [
        `You are processing files one by one to fulfill this request: "${userIntent}"`,
        ``,
        `## All files to be processed (${totalSteps} total):`,
        allFilesList,
        ``,
        completedFiles ? `## Already completed:\n${completedFiles}` : "",
        remainingFiles ? `## Still to do after this step:\n${remainingFiles}` : "",
        ``,
        `---`,
        ``,
        `## Current Task — Step ${stepIndex}/${totalSteps}`,
        `File: ${step.filePath}`,
        `Why: ${step.reason}`,
        fileContext,
        ``,
        `Generate ONLY the changes for ${step.filePath}. Do not modify any other files in this step.`,
        `No shell commands. No npm installs. No explanations — just the file change.`,
      ]
        .filter(Boolean)
        .join("\n"),
    } as any);

    const singleFileMap: FileMap = {};
    if (files[step.filePath]) {
      singleFileMap[step.filePath] = files[step.filePath];
    }

    try {
      const result = await streamText({
        messages: stepMessages,
        env: undefined as any,
        options: streamingOptions,
        apiKeys,
        files: Object.keys(singleFileMap).length > 0 ? singleFileMap : files,
        providerSettings,
        promptId: "plan",
        chatMode,
        designScheme,
        summary,
        contextOptimization: false,
        messageSliceId: undefined,
      });

      const response = result.toDataStreamResponse();

      const [stepText] = await Promise.all([
        result.text,
        response.body
          ? pipeStepStream(requestId, res, response.body, stepIndex)
          : Promise.resolve(),
      ]);

      if (!writer.isAlive()) {
        logger.warn(`[${requestId}] Client disconnected during step ${stepIndex}, aborting batch`);
        return;
      }

      const usage = await result.usage;
      if (usage) {
        cumulativeUsage.completionTokens += usage.completionTokens || 0;
        cumulativeUsage.promptTokens += usage.promptTokens || 0;
        cumulativeUsage.totalTokens += usage.totalTokens || 0;
      }

      logger.info(
        `[${requestId}] Batch step ${stepIndex} finished: file=${step.filePath}, tokens=${usage?.totalTokens || 0}`,
      );

      if (!stepText && !usage?.totalTokens) {
        logger.warn(`[${requestId}] Step ${stepIndex} returned empty response`);
      }

      if (!res.writableEnded && !res.destroyed) {
        const eFrame = {
          finishReason: "stop",
          usage: {
            promptTokens: usage?.promptTokens ?? 0,
            completionTokens: usage?.completionTokens ?? 0,
          },
        };
        res.write(`e:${JSON.stringify(eFrame)}\n`);
      }

      succeededSteps++;

      writer.writeData({
        type: "progress",
        label: `batch-step-${stepIndex}`,
        status: "complete",
        order: progressCounter.value++,
        message: `Step ${stepIndex}/${totalSteps} done: ${step.filePath}`,
      } satisfies ProgressAnnotation);
    } catch (err: any) {
      logger.error(`[${requestId}] Batch step ${stepIndex} error: ${err?.message}`, err);

      writer.writeData({
        type: "progress",
        label: `batch-step-error-${stepIndex}`,
        status: "complete",
        order: progressCounter.value++,
        message: `Step ${stepIndex} failed (${step.filePath}): ${err?.message || "Unknown error"}. Continuing...`,
      } satisfies ProgressAnnotation);

      failedSteps++;
      continue;
    }
  }

  logger.info(
    `[${requestId}] Batch complete: ${succeededSteps} succeeded, ${failedSteps} failed, total tokens: ${cumulativeUsage.totalTokens}`,
  );

  writer.writeData({
    type: "progress",
    label: "batch-complete",
    status: "complete",
    order: progressCounter.value++,
    message: `Batch complete: ${succeededSteps}/${totalSteps} files processed${failedSteps > 0 ? `, ${failedSteps} failed` : ""}`,
  } satisfies ProgressAnnotation);
}

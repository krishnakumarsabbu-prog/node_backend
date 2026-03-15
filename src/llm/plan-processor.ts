import { generateText, type CoreTool, type GenerateTextResult } from "ai";
import { Readable } from "node:stream";
import { generateId } from "ai";
import type { Response } from "express";

import { createScopedLogger } from "../utils/logger";
import { getTachyonModel } from "../modules/llm/providers/tachyon";
import { streamText, type Messages, type StreamingOptions } from "./stream-text";
import type { FileMap } from "./constants";
import type { IProviderSetting } from "../types/model";
import type { DesignScheme } from "../types/design-scheme";
import type { ProgressAnnotation } from "../types/context";
import { searchWithGraph } from "../modules/ai_engine/agent";
import { selectFilesForBuild } from "./batch/batch-planner";

export interface StreamWriter {
  writeData: (data: unknown) => boolean;
  writeAnnotation: (annotation: unknown) => boolean;
  isAlive: () => boolean;
}

const FRAME_RE = /^([0-9a-z]+):(.+)\n?$/;

const logger = createScopedLogger("plan-processor");

export interface PlanStep {
  index: number;
  heading: string;
  details: string;
}

export interface ParsedPlan {
  steps: PlanStep[];
  rawContent: string;
}

export type ExecutionMode = "steps" | "files";

export function extractPlanContent(files: FileMap): string | null {
  for (const [path, entry] of Object.entries(files)) {
    const name = path.split("/").pop()?.toLowerCase();
    if (
      name === "plan.md" &&
      entry &&
      entry.type === "file" &&
      !entry.isBinary &&
      typeof entry.content === "string"
    ) {
      return entry.content;
    }
  }
  return null;
}

export async function parsePlanIntoSteps(
  planContent: string,
  onFinish?: (resp: GenerateTextResult<Record<string, CoreTool<any, any>>, never>) => void,
): Promise<PlanStep[]> {
  logger.info("Parsing PLAN.md into steps via LLM...");

  const resp = await generateText({
    model: getTachyonModel(),
    system: `
You are a project planning assistant. Your job is to read a project plan written in Markdown and break it down into clear, actionable implementation steps.

Return ONLY a valid JSON array — no prose, no markdown fences. Each element must have:
"index"   : number  (1-based sequential integer)
"heading" : string  (concise title for the step, ≤ 80 chars)
"details" : string  (full implementation guidance, tasks, and subtasks for that step)

Rules:
- Preserve all task details from the original plan.
- Group logically-related tasks into a single step (e.g. one phase = one step).
- Keep "heading" short and descriptive.
- "details" may be multi-line; use \\n for newlines inside the JSON string.
- Do NOT add steps that are not in the plan.
- Do NOT wrap output in markdown code fences.
`,
    prompt: `
Here is the project plan:

<plan>
${planContent}
</plan>

Return the structured JSON array of steps now.
`,
  });

  if (onFinish) onFinish(resp);

  try {
    const cleaned = resp.text.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "");
    const parsed = JSON.parse(cleaned) as PlanStep[];
    logger.info(`Parsed ${parsed.length} steps from PLAN.md`);
    return parsed;
  } catch (err: any) {
    logger.error("Failed to parse LLM step response as JSON, falling back to single step", err);
    return [{ index: 1, heading: "Implement Plan", details: planContent }];
  }
}

export async function generateStepsFromQuestion(
  userQuestion: string,
  onFinish?: (resp: GenerateTextResult<Record<string, CoreTool<any, any>>, never>) => void,
): Promise<PlanStep[]> {
  logger.info("Generating implementation steps from user question via LLM...");

  const resp = await generateText({
    model: getTachyonModel(),
    system: `
You are a project planning assistant specializing in industry-level software development. Given a user's request, break it down into clear, actionable implementation steps.

Return ONLY a valid JSON array — no prose, no markdown fences. Each element must have:
"index"   : number  (1-based sequential integer)
"heading" : string  (concise title for the step, ≤ 80 chars)
"details" : string  (full implementation guidance, tasks, and subtasks for that step)

Rules:
- Include ALL types of steps needed: source code, tests, configs, migrations, styles, docs — whatever the request demands
- Steps should be ordered logically
- Group logically-related changes into a single step
- Keep "heading" short and action-oriented
- "details" may be multi-line; use \\n for newlines inside the JSON string
- Do NOT wrap output in markdown code fences
`,
    prompt: `
Here is the user's request:

<request>
${userQuestion}
</request>

Return the structured JSON array of implementation steps.
`,
  });

  if (onFinish) onFinish(resp);

  try {
    const cleaned = resp.text.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "");
    const parsed = JSON.parse(cleaned) as PlanStep[];
    logger.info(`Generated ${parsed.length} steps from user question`);
    return parsed;
  } catch (err: any) {
    logger.error("Failed to parse LLM step response as JSON, falling back to single step", err);
    return [{ index: 1, heading: "Implement Request", details: userQuestion }];
  }
}

export async function generateFileSteps(
  userQuestion: string,
  selectedFiles: Array<{ path: string; reason: string }>,
): Promise<PlanStep[]> {
  return selectedFiles.map((f, i) => ({
    index: i + 1,
    heading: f.path,
    details: `File: ${f.path}\nTask: ${f.reason}\nUser request: ${userQuestion}`,
  }));
}

async function pipeStreamToResponse(
  requestId: string,
  res: Response,
  webStream: ReadableStream,
  stepNum: number,
): Promise<void> {
  if (res.writableEnded || res.destroyed) {
    logger.warn(`[${requestId}] Response already ended before piping step ${stepNum}`);
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
        logger.debug(`[${requestId}] Step ${stepNum} dropping frame: ${prefix}:...`);
        return;
      }

      if (prefix === "3") {
        logger.warn(`[${requestId}] Step ${stepNum} LLM error frame received: ${m[2]}`);
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
      logger.error(`[${requestId}] Step ${stepNum} stream error: ${err?.message || err}`, err);
      reject(err);
    });
  });
}

const MAX_STEP_RETRIES = 2;
const STEP_RETRY_BASE_DELAY_MS = 1_000;

async function streamStep(opts: {
  requestId: string;
  res: Response;
  stepMessages: Messages;
  filesToUse: FileMap;
  allFiles: FileMap;
  streamingOptions: StreamingOptions;
  apiKeys: Record<string, string>;
  providerSettings: Record<string, IProviderSetting>;
  chatMode: "discuss" | "build";
  designScheme?: DesignScheme;
  summary?: string;
  stepIndex: number;
  cumulativeUsage: { completionTokens: number; promptTokens: number; totalTokens: number };
  clientAbortSignal?: AbortSignal;
}): Promise<{ stepText: string; succeeded: boolean }> {
  const { requestId, res, stepMessages, filesToUse, allFiles, stepIndex, cumulativeUsage } = opts;

  for (let attempt = 0; attempt <= MAX_STEP_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = STEP_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      logger.info(`[${requestId}] Step ${stepIndex} retry ${attempt}/${MAX_STEP_RETRIES}, backoff=${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }

    try {
      if (opts.clientAbortSignal?.aborted) {
        return { stepText: "", succeeded: false };
      }

      const result = await streamText({
        messages: stepMessages,
        env: undefined as any,
        options: opts.streamingOptions,
        apiKeys: opts.apiKeys,
        files: allFiles,
        providerSettings: opts.providerSettings,
        promptId: "plan",
        chatMode: opts.chatMode,
        designScheme: opts.designScheme,
        summary: opts.summary,
        contextOptimization: true,
        contextFiles: filesToUse,
        messageSliceId: undefined,
        clientAbortSignal: opts.clientAbortSignal,
      });

      const response = result.toDataStreamResponse();

      const [stepText] = await Promise.all([
        result.text,
        response.body
          ? pipeStreamToResponse(requestId, res, response.body, stepIndex)
          : Promise.resolve(),
      ]);

      const usage = await result.usage;
      if (usage) {
        cumulativeUsage.completionTokens += usage.completionTokens || 0;
        cumulativeUsage.promptTokens += usage.promptTokens || 0;
        cumulativeUsage.totalTokens += usage.totalTokens || 0;
      }

      logger.info(
        `[${requestId}] Step ${stepIndex} finished: tokens=${usage?.totalTokens || 0}${attempt > 0 ? ` (attempt ${attempt + 1})` : ""}`,
      );

      if (!res.writableEnded && !res.destroyed) {
        res.write(
          `e:${JSON.stringify({
            finishReason: "stop",
            usage: {
              promptTokens: usage?.promptTokens ?? 0,
              completionTokens: usage?.completionTokens ?? 0,
            },
          })}\n`,
        );
      }

      return { stepText: stepText || "", succeeded: true };
    } catch (err: any) {
      const isRetryable =
        err?.name === "AbortError" ||
        err?.message?.includes("timed out") ||
        err?.message?.includes("timeout") ||
        err?.message?.includes("ECONNRESET") ||
        err?.message?.includes("socket hang up");

      if (!isRetryable || attempt >= MAX_STEP_RETRIES) {
        logger.error(`[${requestId}] Step ${stepIndex} failed (attempt ${attempt + 1}): ${err?.message}`);
        if (!isRetryable) throw err;
        break;
      }

      logger.warn(`[${requestId}] Step ${stepIndex} attempt ${attempt + 1} failed (retryable): ${err?.message}`);
    }
  }

  return { stepText: "", succeeded: false };
}

function buildTopicStepMessages(
  messages: Messages,
  steps: PlanStep[],
  step: PlanStep,
  usePlanMd: boolean,
  planContent: string | null,
  userQuestion: string | null,
): Messages {
  const stepMessages: Messages = [...messages];

  const allStepsList = steps
    .map(
      (s) =>
        `  ${s.index}. ${s.heading}${s.index === step.index ? " <- CURRENT" : s.index < step.index ? " done" : ""}`,
    )
    .join("\n");

  const remainingSteps = steps
    .filter((s) => s.index > step.index)
    .map((s) => `  ${s.index}. ${s.heading}`)
    .join("\n");

  if (step.index > 1) {
    const prevStep = steps[step.index - 2];
    stepMessages.push({
      id: generateId(),
      role: "assistant",
      content: `Step ${prevStep.index}/${steps.length} complete: ${prevStep.heading}.`,
    } as any);

    stepMessages.push({
      id: generateId(),
      role: "user",
      content: [
        `## Plan Progress`,
        allStepsList,
        ``,
        `## Your Task - Step ${step.index}/${steps.length}: ${step.heading}`,
        ``,
        step.details,
        ``,
        remainingSteps
          ? `## Do NOT implement yet (upcoming steps):\n${remainingSteps}`
          : `## This is the FINAL step - complete the implementation.`,
        ``,
        `Generate ONLY the file changes required for Step ${step.index}. No shell commands. No npm installs.`,
      ].join("\n"),
    } as any);
  } else {
    const planContext = usePlanMd
      ? [`## Full Plan Details (for reference only)`, planContent!, ``]
      : [`## User Request`, userQuestion!, ``];

    stepMessages.push({
      id: generateId(),
      role: "user",
      content: [
        `You are implementing a project plan step by step. There are ${steps.length} steps in total.`,
        ``,
        ...planContext,
        `## Full Plan Overview`,
        allStepsList,
        ``,
        `---`,
        ``,
        `## Your Task - Step ${step.index}/${steps.length}: ${step.heading}`,
        ``,
        step.details,
        ``,
        remainingSteps
          ? `## Do NOT implement yet (upcoming steps):\n${remainingSteps}`
          : `## This is the ONLY step - complete the full implementation.`,
        ``,
        `Generate ONLY the file changes required for Step ${step.index}. No shell commands. No npm installs.`,
      ].join("\n"),
    } as any);
  }

  return stepMessages;
}

function buildFileStepMessages(
  messages: Messages,
  steps: PlanStep[],
  step: PlanStep,
  userQuestion: string,
  files: FileMap,
): Messages {
  const stepMessages: Messages = [...messages];

  const filePath = step.heading;
  const allFilesList = steps.map((s) => `  ${s.index}. ${s.heading}`).join("\n");

  const completedFiles = steps
    .slice(0, step.index - 1)
    .map((s) => `  - ${s.heading}`)
    .join("\n");

  const remainingFiles = steps
    .slice(step.index)
    .map((s) => `  - ${s.heading}`)
    .join("\n");

  const existingFile = files[filePath];
  const fileContext =
    existingFile && existingFile.type === "file" && !existingFile.isBinary
      ? `\n\nCurrent content of ${filePath}:\n\`\`\`\n${existingFile.content}\n\`\`\``
      : `\n\n${filePath} does not exist yet — create it from scratch.`;

  if (step.index > 1) {
    const prevStep = steps[step.index - 2];
    stepMessages.push({
      id: generateId(),
      role: "assistant",
      content: `Step ${step.index - 1}/${steps.length} complete: processed ${prevStep.heading}.`,
    } as any);
  }

  stepMessages.push({
    id: generateId(),
    role: "user",
    content: [
      `You are processing files one by one to fulfill this request: "${userQuestion}"`,
      ``,
      `## All files to be processed (${steps.length} total):`,
      allFilesList,
      ``,
      completedFiles ? `## Already completed:\n${completedFiles}` : "",
      remainingFiles ? `## Still to do after this step:\n${remainingFiles}` : "",
      ``,
      `---`,
      ``,
      `## Current Task — Step ${step.index}/${steps.length}`,
      `File: ${filePath}`,
      step.details,
      fileContext,
      ``,
      `Generate ONLY the changes for ${filePath}. Do not modify any other files in this step.`,
      `No shell commands. No npm installs.`,
    ]
      .filter(Boolean)
      .join("\n"),
  } as any);

  return stepMessages;
}

function extractGeneratedFiles(stepText: string, currentFiles: FileMap): FileMap {
  const updated: FileMap = {};
  const fileBlockRe = /<cortexAction[^>]*type="file"[^>]*filePath="([^"]+)"[^>]*>([\s\S]*?)<\/cortexAction>/g;
  let match: RegExpExecArray | null;
  while ((match = fileBlockRe.exec(stepText)) !== null) {
    const rawPath = match[1];
    const content = match[2];
    const fullPath = rawPath.startsWith('/') ? rawPath : `/home/project/${rawPath}`;
    updated[fullPath] = { type: 'file', content, isBinary: false } as any;
  }
  return updated;
}

export interface StreamPlanOptions {
  res: Response;
  requestId: string;
  messages: Messages;
  files: FileMap;
  userQuestion?: string;
  streamingOptions: StreamingOptions;
  apiKeys: Record<string, string>;
  providerSettings: Record<string, IProviderSetting>;
  promptId: string;
  chatMode: "discuss" | "build";
  designScheme?: DesignScheme;
  progressCounter: { value: number };
  writer: StreamWriter;
  summary?: string;
  clientAbortSignal?: AbortSignal;
  cumulativeUsage: {
    completionTokens: number;
    promptTokens: number;
    totalTokens: number;
  };
}

/**
 * How many files the LLM must select before switching to file-per-step mode.
 * Set to 1 so that ANY non-trivial request with file selection uses file-per-step,
 * giving users full per-file progress visibility.
 */
const FILE_PER_STEP_THRESHOLD = 1;

export async function streamPlanResponse(opts: StreamPlanOptions): Promise<void> {
  const {
    res,
    requestId,
    messages,
    files,
    userQuestion,
    streamingOptions,
    apiKeys,
    providerSettings,
    chatMode,
    designScheme,
    summary,
    progressCounter,
    writer,
    cumulativeUsage,
    clientAbortSignal,
  } = opts;

  const planContent = extractPlanContent(files);
  const usePlanMd = !!planContent;

  if (!usePlanMd && !userQuestion?.trim()) {
    logger.warn(`[${requestId}] No PLAN.md and no user question — skipping`);
    writer.writeData({
      type: "progress",
      label: "plan",
      status: "complete",
      order: progressCounter.value++,
      message: "No PLAN.md and no user question — skipping",
    } satisfies ProgressAnnotation);
    return;
  }

  const onUsage = (resp: any) => {
    if (resp?.usage) {
      cumulativeUsage.completionTokens += resp.usage.completionTokens || 0;
      cumulativeUsage.promptTokens += resp.usage.promptTokens || 0;
      cumulativeUsage.totalTokens += resp.usage.totalTokens || 0;
    }
  };

  let executionMode: ExecutionMode = "steps";
  let steps: PlanStep[] = [];
  let selectedFileList: Array<{ path: string; reason: string }> = [];

  if (usePlanMd) {
    logger.info(`[${requestId}] PLAN.md found (${planContent!.length} chars) — parsing into steps`);

    writer.writeData({
      type: "progress",
      label: "plan-parse",
      status: "in-progress",
      order: progressCounter.value++,
      message: "Reading implementation plan...",
    } satisfies ProgressAnnotation);

    try {
      steps = await parsePlanIntoSteps(planContent!, onUsage);
    } catch (err: any) {
      writer.writeData({
        type: "progress",
        label: "plan-parse",
        status: "complete",
        order: progressCounter.value++,
        message: `Failed to parse plan: ${err?.message}`,
      } satisfies ProgressAnnotation);
      return;
    }

    executionMode = "steps";
  } else {
    logger.info(`[${requestId}] Build mode — selecting files for: "${userQuestion!.substring(0, 80)}"`);

    writer.writeData({
      type: "progress",
      label: "plan-parse",
      status: "in-progress",
      order: progressCounter.value++,
      message: "Analysing project and identifying files to modify...",
    } satisfies ProgressAnnotation);

    try {
      const batchPlan = await selectFilesForBuild(userQuestion!, files, onUsage);
      selectedFileList = batchPlan.files;
    } catch (err: any) {
      logger.warn(`[${requestId}] File selection failed (${err?.message}), falling back to steps mode`);
      selectedFileList = [];
    }

    logger.info(`[${requestId}] File selector returned ${selectedFileList.length} files`);

    if (selectedFileList.length > FILE_PER_STEP_THRESHOLD) {
      executionMode = "files";
      steps = await generateFileSteps(userQuestion!, selectedFileList);
      logger.info(`[${requestId}] Execution mode: files (${steps.length} file steps)`);
    } else if (selectedFileList.length === 1) {
      executionMode = "files";
      steps = await generateFileSteps(userQuestion!, selectedFileList);
      logger.info(`[${requestId}] Execution mode: files (single file)`);
    } else {
      executionMode = "steps";
      logger.info(`[${requestId}] Execution mode: steps (no files selected — topic grouping)`);

      try {
        steps = await generateStepsFromQuestion(userQuestion!, onUsage);
      } catch (err: any) {
        writer.writeData({
          type: "progress",
          label: "plan-parse",
          status: "complete",
          order: progressCounter.value++,
          message: `Failed to generate steps: ${err?.message}`,
        } satisfies ProgressAnnotation);
        return;
      }
    }
  }

  writer.writeData({
    type: "progress",
    label: "plan-parse",
    status: "complete",
    order: progressCounter.value++,
    message:
      executionMode === "files"
        ? `Plan ready: ${steps.length} file${steps.length !== 1 ? "s" : ""} to process`
        : `Plan ready: ${steps.length} implementation step${steps.length !== 1 ? "s" : ""}`,
  } satisfies ProgressAnnotation);

  writer.writeAnnotation({
    type: "planSteps",
    steps: steps.map((s) => ({ index: s.index, heading: s.heading })),
    totalSteps: steps.length,
    executionMode,
  });

  const sharedMessageId = generateId();
  res.write(`f:${JSON.stringify({ messageId: sharedMessageId })}\n`);
  logger.info(`[${requestId}] Emitted shared messageId: ${sharedMessageId}`);

  let succeededSteps = 0;
  let failedSteps = 0;

  const accumulatedFiles: FileMap = { ...files };

  for (const step of steps) {
    if (!writer.isAlive()) {
      logger.warn(`[${requestId}] Client disconnected before step ${step.index}, aborting`);
      return;
    }

    logger.info(`[${requestId}] Step ${step.index}/${steps.length}: "${step.heading}" [${executionMode}]`);

    writer.writeData({
      type: "progress",
      label: `plan-step${step.index}`,
      status: "in-progress",
      order: progressCounter.value++,
      message: `Step ${step.index}/${steps.length}: ${step.heading}`,
    } satisfies ProgressAnnotation);

    const stepMessages =
      executionMode === "files"
        ? buildFileStepMessages(messages, steps, step, userQuestion!, accumulatedFiles)
        : buildTopicStepMessages(messages, steps, step, usePlanMd, planContent, userQuestion ?? null);

    let filesToUse: FileMap = accumulatedFiles;

    if (executionMode === "files") {
      const specificFile = accumulatedFiles[step.heading];
      if (specificFile) {
        filesToUse = { [step.heading]: specificFile };
      } else {
        filesToUse = {};
      }
    } else {
      try {
        const query = `${step.heading} ${step.details}`;
        const relevantPaths: string[] = searchWithGraph(query, 5, 1);
        if (relevantPaths.length > 0) {
          const stepFiles: FileMap = {};
          for (const relPath of relevantPaths) {
            const fullPath = `/home/project/${relPath}`;
            if (Object.prototype.hasOwnProperty.call(accumulatedFiles, fullPath)) {
              stepFiles[fullPath] = accumulatedFiles[fullPath];
            }
          }
          if (Object.keys(stepFiles).length > 0) {
            filesToUse = stepFiles;
          }
        }
      } catch {
        // index not available — use full file set
      }
    }

    logger.info(
      `[${requestId}] Step ${step.index} context: ${Object.keys(filesToUse).length} focused files, ${Object.keys(accumulatedFiles).length} total files available`,
    );

    try {
      const { stepText, succeeded } = await streamStep({
        requestId,
        res,
        stepMessages,
        filesToUse,
        allFiles: accumulatedFiles,
        streamingOptions,
        apiKeys,
        providerSettings,
        chatMode,
        designScheme,
        summary,
        stepIndex: step.index,
        cumulativeUsage,
        clientAbortSignal,
      });

      if (!succeeded) {
        logger.warn(`[${requestId}] Step ${step.index} reported failure (all retries exhausted), skipping file extraction`);
        failedSteps++;
        writer.writeData({
          type: "progress",
          label: "plan-step-error",
          status: "complete",
          order: progressCounter.value++,
          message: `Step ${step.index} failed after all retries. Continuing with remaining steps...`,
        } satisfies ProgressAnnotation);
        continue;
      }

      const generatedFiles = extractGeneratedFiles(stepText, accumulatedFiles);
      const generatedCount = Object.keys(generatedFiles).length;
      if (generatedCount > 0) {
        Object.assign(accumulatedFiles, generatedFiles);
        logger.info(`[${requestId}] Step ${step.index} produced ${generatedCount} file(s), accumulated state updated`);
      }

      if (!writer.isAlive()) {
        logger.warn(`[${requestId}] Client disconnected during step ${step.index}, aborting`);
        return;
      }

      succeededSteps++;

      writer.writeData({
        type: "progress",
        label: `plan-step${step.index}`,
        status: "complete",
        order: progressCounter.value++,
        message: `Step ${step.index}/${steps.length} done: ${step.heading}`,
      } satisfies ProgressAnnotation);
    } catch (err: any) {
      logger.error(`[${requestId}] Step ${step.index} error: ${err?.message}`, err);

      writer.writeData({
        type: "progress",
        label: "plan-step-error",
        status: "complete",
        order: progressCounter.value++,
        message: `Step ${step.index} failed: ${err?.message || "Unknown error"}. Continuing...`,
      } satisfies ProgressAnnotation);

      failedSteps++;

      const totalAttempted = succeededSteps + failedSteps;
      if (totalAttempted >= 3) {
        const failureRate = failedSteps / totalAttempted;
        if (failureRate >= 0.6) {
          logger.error(`[${requestId}] Circuit breaker triggered: ${failedSteps}/${totalAttempted} steps failed (${Math.round(failureRate * 100)}%). Aborting plan.`);
          writer.writeData({
            type: "progress",
            label: "plan-error",
            status: "complete",
            order: progressCounter.value++,
            message: `Plan aborted: ${failedSteps} of ${totalAttempted} steps failed. This may indicate an issue with the model or request. Please try again.`,
          } satisfies ProgressAnnotation);
          break;
        }
      }

      continue;
    }
  }

  logger.info(
    `[${requestId}] All ${steps.length} steps complete. succeeded=${succeededSteps} failed=${failedSteps} totalTokens=${cumulativeUsage.totalTokens}`,
  );

  writer.writeData({
    type: "progress",
    label: "plan-complete",
    status: "complete",
    order: progressCounter.value++,
    message: `Implementation complete: ${succeededSteps}/${steps.length} step${steps.length !== 1 ? "s" : ""} executed${failedSteps > 0 ? `, ${failedSteps} failed` : ""}`,
  } satisfies ProgressAnnotation);
}

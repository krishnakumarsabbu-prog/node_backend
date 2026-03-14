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

// ---------------------------------------------------------------------------
// Frame protocol
// ---------------------------------------------------------------------------

const FRAME_RE = /^([0-9a-z]+):(.+)\n?$/;

function stripCodeFencesFromFullText(text: string): string {
  text = text.replace(/```[a-z]*\r?\n(?=<cortexArtifact)/gi, "");
  text = text.replace(/(?<=<\/cortexArtifact>)\r?\n```/gi, "");
  text = text.replace(/^```[a-z]*\r?\n/i, "");
  text = text.replace(/\r?\n```\s*$/i, "");
  return text;
}

const logger = createScopedLogger("plan-processor");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlanStep {
  index: number;
  heading: string;
  details: string;
}

export interface ParsedPlan {
  steps: PlanStep[];
  rawContent: string;
}

/**
 * When the execution strategy is "files", each step maps to one specific file.
 * The step heading is the file path, details describe what to do with it.
 */
export type ExecutionMode = "steps" | "files";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// LLM: parse PLAN.md into topic-based steps
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// LLM: generate topic-based steps from a user question (≤5 files scenario)
// ---------------------------------------------------------------------------

export async function generateStepsFromQuestion(
  userQuestion: string,
  onFinish?: (resp: GenerateTextResult<Record<string, CoreTool<any, any>>, never>) => void,
): Promise<PlanStep[]> {
  logger.info("Generating implementation steps from user question via LLM...");

  const resp = await generateText({
    model: getTachyonModel(),
    system: `
You are a project planning assistant specializing in industry-level software development. Given a user's request, break it down into clear, actionable SOURCE CODE implementation steps only.

Return ONLY a valid JSON array — no prose, no markdown fences. Each element must have:
"index"   : number  (1-based sequential integer)
"heading" : string  (concise title for the step, ≤ 80 chars)
"details" : string  (full implementation guidance, tasks, and subtasks for that step)

STRICT RULES — WHAT TO INCLUDE:
- ONLY steps that involve writing, modifying, or creating SOURCE CODE files
- Steps must produce concrete file changes (components, services, APIs, schemas, configs, styles, etc.)
- Steps should be ordered logically: data models and schemas first, then business logic, then UI components, then integrations

STRICT RULES — WHAT TO EXCLUDE (DO NOT generate steps for these):
- Documentation writing (README, API docs, wiki, changelogs, comments)
- Unit tests, integration tests, end-to-end tests, test suites, test fixtures
- Deployment scripts, CI/CD pipelines, Docker, Kubernetes, infrastructure
- Code reviews, audits, refactoring passes
- Any step that does not produce a source code file change

Additional rules:
- Group logically-related code changes into a single step
- Keep "heading" short and action-oriented (e.g. "Build User Auth Service", "Create Dashboard UI")
- "details" may be multi-line; use \\n for newlines inside the JSON string
- Do NOT wrap output in markdown code fences
`,
    prompt: `
Here is the user's request:

<request>
${userQuestion}
</request>

Return the structured JSON array of SOURCE CODE implementation steps only. Exclude any documentation, testing, or deployment steps.
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

// ---------------------------------------------------------------------------
// LLM: generate file-per-step plan from user question + selected files
// (used when LLM selects >5 files — each file becomes its own step)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Internal: pipe one step stream to express response
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Internal: stream one step and write e: frame
// ---------------------------------------------------------------------------

async function streamStep(opts: {
  requestId: string;
  res: Response;
  stepMessages: Messages;
  filesToUse: FileMap;
  streamingOptions: StreamingOptions;
  apiKeys: Record<string, string>;
  providerSettings: Record<string, IProviderSetting>;
  chatMode: "discuss" | "build";
  designScheme?: DesignScheme;
  summary?: string;
  stepIndex: number;
  cumulativeUsage: { completionTokens: number; promptTokens: number; totalTokens: number };
}): Promise<{ stepText: string; succeeded: boolean }> {
  const { requestId, res, stepMessages, filesToUse, stepIndex, cumulativeUsage } = opts;

  const result = await streamText({
    messages: stepMessages,
    env: undefined as any,
    options: opts.streamingOptions,
    apiKeys: opts.apiKeys,
    files: filesToUse,
    providerSettings: opts.providerSettings,
    promptId: "plan",
    chatMode: opts.chatMode,
    designScheme: opts.designScheme,
    summary: opts.summary,
    contextOptimization: false,
    messageSliceId: undefined,
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

  logger.info(`[${requestId}] Step ${stepIndex} finished: tokens=${usage?.totalTokens || 0}`);

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
}

// ---------------------------------------------------------------------------
// Internal: build per-step messages for topic-based steps
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Internal: build per-step messages for file-per-step execution
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Public options type
// ---------------------------------------------------------------------------

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
  cumulativeUsage: {
    completionTokens: number;
    promptTokens: number;
    totalTokens: number;
  };
}

// ---------------------------------------------------------------------------
// Main entry-point
// ---------------------------------------------------------------------------

/**
 * Unified plan execution engine.
 *
 * Decision tree:
 *  - If PLAN.md present (implementPlan=true): parse it into topic steps → execute
 *  - If build mode with user question:
 *      1. Ask LLM to select files from the project
 *      2. If selected files > FILE_PER_STEP_THRESHOLD: one file = one step ("files" mode)
 *      3. Otherwise: generate topic-based steps and use file-index for context per step ("steps" mode)
 */
const FILE_PER_STEP_THRESHOLD = 5;

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

  // ── 1. Determine execution mode ──────────────────────────────────────────

  let executionMode: ExecutionMode = "steps";
  let steps: PlanStep[] = [];
  let selectedFileList: Array<{ path: string; reason: string }> = [];

  if (usePlanMd) {
    // PLAN.md present → always topic-based steps
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
    // Build mode: first ask LLM which files need to change
    logger.info(`[${requestId}] Build mode — selecting files for: "${userQuestion!.substring(0, 80)}"`);

    writer.writeData({
      type: "progress",
      label: "plan-parse",
      status: "in-progress",
      order: progressCounter.value++,
      message: "Identifying files to modify...",
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
      // Many files → one file per step
      executionMode = "files";
      steps = await generateFileSteps(userQuestion!, selectedFileList);
      logger.info(`[${requestId}] Execution mode: files (${steps.length} file steps)`);
    } else {
      // Few or no files → topic-based steps (LLM decides grouping)
      executionMode = "steps";
      logger.info(`[${requestId}] Execution mode: steps (${selectedFileList.length} files → topic grouping)`);

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
        ? `${steps.length} file${steps.length !== 1 ? "s" : ""} queued — processing one per step`
        : `Plan ready: ${steps.length} step${steps.length !== 1 ? "s" : ""}`,
  } satisfies ProgressAnnotation);

  writer.writeAnnotation({
    type: "planSteps",
    steps: steps.map((s) => ({ index: s.index, heading: s.heading })),
    totalSteps: steps.length,
    executionMode,
  });

  // ── 2. Emit shared messageId header ──────────────────────────────────────

  const sharedMessageId = generateId();
  res.write(`f:${JSON.stringify({ messageId: sharedMessageId })}\n`);
  logger.info(`[${requestId}] Emitted shared messageId: ${sharedMessageId}`);

  // ── 3. Execute steps ──────────────────────────────────────────────────────

  let succeededSteps = 0;
  let failedSteps = 0;

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
      message:
        executionMode === "files"
          ? `Step ${step.index}/${steps.length}: ${step.heading}`
          : `Step ${step.index}/${steps.length}: ${step.heading}`,
    } satisfies ProgressAnnotation);

    // Build messages for this step
    const stepMessages =
      executionMode === "files"
        ? buildFileStepMessages(messages, steps, step, userQuestion!, files)
        : buildTopicStepMessages(messages, steps, step, usePlanMd, planContent, userQuestion ?? null);

    // Select files to inject into context
    let filesToUse: FileMap = files;

    if (executionMode === "files") {
      // Inject only the specific file being processed
      const specificFile = files[step.heading];
      if (specificFile) {
        filesToUse = { [step.heading]: specificFile };
      } else {
        filesToUse = {};
      }
    } else {
      // Topic-based: use graph search for relevant files
      try {
        const query = `${step.heading} ${step.details}`;
        const relevantPaths: string[] = searchWithGraph(query, 5, 1);
        if (relevantPaths.length > 0) {
          const stepFiles: FileMap = {};
          for (const relPath of relevantPaths) {
            const fullPath = `/home/project/${relPath}`;
            if (Object.prototype.hasOwnProperty.call(files, fullPath)) {
              stepFiles[fullPath] = files[fullPath];
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
      `[${requestId}] Step ${step.index} using ${Object.keys(filesToUse).length}/${Object.keys(files).length} files`,
    );

    try {
      await streamStep({
        requestId,
        res,
        stepMessages,
        filesToUse,
        streamingOptions,
        apiKeys,
        providerSettings,
        chatMode,
        designScheme,
        summary,
        stepIndex: step.index,
        cumulativeUsage,
      });

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
      continue;
    }
  }

  // ── 4. Done ───────────────────────────────────────────────────────────────

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

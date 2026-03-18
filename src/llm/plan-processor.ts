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
import { searchWithGraph, patchIndex, type PatchEntry } from "../modules/ai_engine/agent";
import { selectFilesForBuild } from "./batch/batch-planner";

const TEST_INTENT_PATTERNS = [
  /\btest(s|ing|ed)?\b/i,
  /\bunit test/i,
  /\bintegration test/i,
  /\be2e\b/i,
  /\bend[- ]to[- ]end\b/i,
  /\bspec(s)?\b/i,
  /\bvitest\b/i,
  /\bjest\b/i,
  /\bcypress\b/i,
  /\bplaywright\b/i,
];

function isTestGenerationRequest(question: string): boolean {
  return TEST_INTENT_PATTERNS.some((re) => re.test(question));
}

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
You are a world-class software architect with 30+ years of experience decomposing projects into precise, executable implementation steps.

Your job: read a project plan and produce a clean, ordered list of CODE CHANGE STEPS only.

Return ONLY a valid JSON array — no prose, no markdown fences. Each element must have:
"index"   : number  (1-based sequential integer)
"heading" : string  (concise action-oriented title ≤ 80 chars, starting with a verb: "Add", "Create", "Update", "Implement", "Refactor", "Wire", "Integrate")
"details" : string  (precise implementation guidance covering: what to create/modify, which functions/components/interfaces to write, which patterns to follow, and how this step connects to adjacent steps)

DESIGN FIRST — Before splitting into steps, mentally answer:
1. What is the optimal architecture for this feature? (data flow, component boundaries, service layers)
2. What is the correct execution order to avoid rework? (types/interfaces → data layer → business logic → API/routes → UI)
3. Where are the natural seams between steps that produce zero overlap?

STEP RULES:
- Include ONLY source code change steps — no documentation steps, no test steps, no README updates
- Each step must produce shippable, compilable file changes
- Order steps so each one builds directly on the previous (dependency order)
- Zero overlap between steps — if two steps touch the same file, merge them into one
- Split by concern: types, data layer, business logic, API integration, UI components are separate steps
- If a step would touch more than 5 files, split it further
- Steps must be granular enough that each one is a focused, reviewable unit of work
- Never create a "Setup" or "Boilerplate" catch-all step — be specific about what is created
- Never combine frontend + backend changes in one step unless they are tightly coupled (e.g. a single hook + its API endpoint)

FORBIDDEN steps (never include):
- Documentation / README / comments
- Test files / unit tests / integration tests / e2e tests
- Linting / formatting / code style cleanup
- Deployment / CI/CD configuration
- Version bumps / changelog entries

OUTPUT: JSON array only. No explanation. No fences.
`,
    prompt: `
Here is the project plan:

<plan>
${planContent}
</plan>

Think through the best architecture and zero-overlap execution order, then return the JSON array of code change steps.
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
You are a world-class software architect with 30+ years of experience. You have an exceptional ability to decompose any feature request into a precise, deeply complete set of code change steps — covering every layer of the stack needed to fully implement the functionality.

Your job: take a user's feature request and produce the optimal ordered list of CODE CHANGE STEPS that will fully implement it, end-to-end, with zero gaps.

Return ONLY a valid JSON array — no prose, no markdown fences. Each element must have:
"index"   : number  (1-based sequential integer)
"heading" : string  (concise action-oriented title ≤ 80 chars, starting with a verb: "Add", "Create", "Update", "Implement", "Refactor", "Wire", "Integrate", "Extend", "Build")
"details" : string  (precise implementation guidance: exact files to create/modify, specific functions/components/types to write, data shapes, API contracts, UI behavior, and how this step integrates with the previous and next steps)

THINK BEFORE YOU PLAN — run this mental checklist:
1. What is the ideal architecture for this feature? (consider: data model, service layer, API shape, state management, UI components)
2. What is the correct dependency order? Standard order: shared types/interfaces → database/schema → data access layer → business logic/services → API routes/hooks → UI components → wiring/integration
3. Where are the natural seams with zero overlap? Each step must own distinct files.
4. Is the feature fully covered? Every user-facing behavior, every data flow, every UI state (loading, empty, error, success) must be handled by some step.

STEP RULES:
- Create AS MANY STEPS AS NEEDED to implement the functionality completely and deeply — do not compress unrelated concerns into one step to save count
- Each step must produce shippable, compilable code that compiles without errors
- Order steps in strict dependency order — no step should require code from a later step
- Zero overlap between steps — if two steps would modify the same file, merge them into one step
- Split by architectural layer: types, db schema, data access, business logic, API/routing, UI components, state/hooks, integration/wiring
- Each step should be focused and reviewable — a senior developer should be able to implement it in one sitting
- Steps for data-heavy features must include: schema/model → repository/query layer → service/transformer → UI data binding
- Steps for UI-heavy features must include: component structure → state management → data fetching → interaction handlers → visual polish
- Steps for API features must include: request/response types → validation → handler logic → error handling → client integration

FORBIDDEN steps (never include any of these):
- Documentation / README / JSDoc / inline comments
- Test files / unit tests / integration tests / e2e tests / test utilities
- Linting / formatting / Prettier / ESLint configuration
- Deployment scripts / CI/CD / Docker / environment configs
- Version bumps / changelog / release notes

OUTPUT: JSON array only. No explanation text. No markdown fences. No preamble.
`,
    prompt: `
User's request:

<request>
${userQuestion}
</request>

Think through the optimal architecture and zero-overlap step order that fully implements this request end-to-end. Then return the JSON array of code change steps.
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
  promptId?: string;
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
        promptId: opts.promptId ?? "plan",
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

function isTestFile(filePath: string): boolean {
  return (
    /\.(test|spec)\.[tj]sx?$/.test(filePath) ||
    /(^|\/)(__tests__|tests?)\//i.test(filePath)
  );
}

function resolveSourceFileForTest(testPath: string, files: FileMap): string | null {
  const stripped = testPath
    .replace(/\.(test|spec)(\.[tj]sx?)$/, "$2")
    .replace(/(^|\/)__tests__\//, "$1")
    .replace(/(^|\/)tests?\//, "$1");

  const candidates = [
    stripped,
    stripped.replace(/\.[tj]sx?$/, ".ts"),
    stripped.replace(/\.[tj]sx?$/, ".tsx"),
    stripped.replace(/\.[tj]sx?$/, ".js"),
    stripped.replace(/\.[tj]sx?$/, ".jsx"),
  ];

  for (const candidate of candidates) {
    if (files[candidate] && files[candidate].type === "file") return candidate;
    const withSrc = candidate.startsWith("/home/project/src/")
      ? candidate
      : candidate.replace("/home/project/", "/home/project/src/");
    if (files[withSrc] && files[withSrc].type === "file") return withSrc;
  }

  return null;
}

function STEP_EXECUTION_INSTRUCTIONS(stepIndex: number): string {
  return [
    `## Execution Rules for Step ${stepIndex}`,
    ``,
    `You are an expert software engineer. Apply the following rules strictly:`,
    ``,
    `**For NEW files being created:**`,
    `- Generate the complete, production-ready implementation — not a stub or skeleton`,
    `- Include all necessary imports, exports, types, error handling, and edge cases`,
    `- Design the file as an architect would: correct structure, clean abstractions, idiomatic patterns for the language/framework`,
    ``,
    `**For EXISTING files being modified:**`,
    `- Make ONLY the changes required by this step — do not rewrite or restructure unrelated code`,
    `- Preserve all existing logic, formatting, and comments outside the changed area`,
    `- Surgical precision: change what must change, leave everything else intact`,
    ``,
    `**For TEST files (new or existing):**`,
    `- Cover all meaningful scenarios: happy path, edge cases, boundary conditions, error/failure paths`,
    `- Each test must be independently readable and clearly named`,
    `- Mock external dependencies; test behavior, not implementation details`,
    `- Aim for full branch coverage on the code under test`,
    ``,
    `No shell commands. No npm installs. Output only file changes.`,
  ].join("\n");
}

function FILE_STEP_EXECUTION_INSTRUCTIONS(filePath: string, fileExists: boolean, userQuestion: string): string {
  const isTest = isTestFile(filePath);

  if (isTest) {
    return [
      `## Execution Rules — Test File: ${filePath}`,
      ``,
      `You are writing a comprehensive test suite. Apply these rules:`,
      ``,
      `- Cover ALL meaningful scenarios: happy path, every edge case, boundary values, and all failure/error paths`,
      `- Name each test so it reads like a specification ("should return X when Y")`,
      `- Mock all external dependencies (network, filesystem, databases, third-party modules)`,
      `- Test observable behavior, not internal implementation details`,
      `- Each test must be fully self-contained and able to run in isolation`,
      `- Aim for complete branch coverage of the code under test`,
      `- ${fileExists ? `Extend the existing test file — preserve passing tests, add missing coverage` : `Create the full test suite from scratch for this file`}`,
      ``,
      `No shell commands. No npm installs. Output only this file.`,
    ].join("\n");
  }

  if (!fileExists) {
    return [
      `## Execution Rules — New File: ${filePath}`,
      ``,
      `You are creating this file from scratch. Apply these rules:`,
      ``,
      `- Generate the COMPLETE, production-ready implementation — not a stub, not a placeholder`,
      `- Think as an architect: what is the full responsibility of this file given the request "${userQuestion}"?`,
      `- Include all imports, exports, types, interfaces, error handling, and edge case logic`,
      `- Follow the naming conventions, code style, and patterns already established in this project`,
      `- Do not leave TODOs or placeholder comments — implement everything this file needs to do`,
      ``,
      `No shell commands. No npm installs. Output only this file.`,
    ].join("\n");
  }

  return [
    `## Execution Rules — Modifying Existing File: ${filePath}`,
    ``,
    `You are modifying this file. Apply these rules:`,
    ``,
    `- Make ONLY the changes required to fulfill the current task`,
    `- Do NOT rewrite, reformat, or restructure code that is not part of this change`,
    `- Preserve all existing logic, variable names, comments, and code style outside the changed area`,
    `- Surgical precision: if only one function needs to change, only that function changes`,
    `- Do not add or remove imports unless directly required by your change`,
    ``,
    `No shell commands. No npm installs. Output only this file.`,
  ].join("\n");
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
        STEP_EXECUTION_INSTRUCTIONS(step.index),
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
        STEP_EXECUTION_INSTRUCTIONS(step.index),
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

  const sourceFileContext = (() => {
    if (!isTestFile(filePath)) return "";
    const sourcePath = resolveSourceFileForTest(filePath, files);
    if (!sourcePath) return "";
    const sourceFile = files[sourcePath];
    if (!sourceFile || sourceFile.type !== "file" || sourceFile.isBinary) return "";
    return `\n\n## Source file under test — ${sourcePath}:\n\`\`\`\n${sourceFile.content}\n\`\`\``;
  })();

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
      sourceFileContext,
      ``,
      FILE_STEP_EXECUTION_INSTRUCTIONS(filePath, !!existingFile, userQuestion),
    ]
      .filter(Boolean)
      .join("\n"),
  } as any);

  return stepMessages;
}

function sanitizeGeneratedPath(rawPath: string): string | null {
  const normalized = rawPath.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (normalized.includes('..') || normalized.includes('\0')) return null;
  const base = normalized.startsWith('/') ? normalized : `/home/project/${normalized}`;
  if (!base.startsWith('/home/project/')) return null;
  return base;
}

function extractGeneratedFiles(stepText: string, currentFiles: FileMap): FileMap {
  const updated: FileMap = {};
  const fileBlockRe = /<cortexAction[^>]*type="file"[^>]*filePath="([^"]+)"[^>]*>([\s\S]*?)<\/cortexAction>/g;
  let match: RegExpExecArray | null;
  while ((match = fileBlockRe.exec(stepText)) !== null) {
    const rawPath = match[1];
    const content = match[2];
    const fullPath = sanitizeGeneratedPath(rawPath);
    if (!fullPath) {
      logger.warn(`extractGeneratedFiles: skipping suspicious path "${rawPath}"`);
      continue;
    }
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
  /**
   * When true: the user explicitly clicked "Implement Plan" — read steps from plan.md.
   * When false/absent: treat as a normal question, even if plan.md exists in the file set.
   */
  implementPlan?: boolean;
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

const CIRCUIT_BREAKER_MIN_ATTEMPTS = 5;
const CIRCUIT_BREAKER_FAILURE_RATE = 0.7;
const GRAPH_SEARCH_MAX_FILES = 40;
const GRAPH_SEARCH_DEPTH = 3;

/**
 * Minimum number of files the LLM must select before switching to file-per-step
 * batch mode. Below this threshold the request is handled as a single architectural
 * topic pass via generateStepsFromQuestion, which is better for focused changes.
 * At or above this threshold every file gets its own step for full progress visibility.
 */
const FILE_PER_STEP_THRESHOLD = 10;


export async function streamPlanResponse(opts: StreamPlanOptions): Promise<void> {
  const {
    res,
    requestId,
    messages,
    files,
    userQuestion,
    implementPlan,
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

  // ── Mode resolution ────────────────────────────────────────────────────────
  //
  //  PLAN MODE   : implementPlan === true  → parse plan.md into steps
  //  QUESTION    : implementPlan !== true  → file-selection + topic steps
  //                (plan.md may exist in the file set, but we IGNORE it here)
  //  MIGRATE     : handled upstream by chat-migrate.ts, never reaches here
  //
  const planContent = implementPlan ? extractPlanContent(files) : null;
  const usePlanMd = !!planContent;

  if (!usePlanMd && !userQuestion?.trim()) {
    logger.warn(`[${requestId}] No implementPlan flag and no user question — skipping`);
    writer.writeData({
      type: "progress",
      label: "plan",
      status: "complete",
      order: progressCounter.value++,
      message: "Nothing to implement — provide a question or click 'Implement Plan'.",
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

  // ── Branch A: implement plan.md ───────────────────────────────────────────
  if (usePlanMd) {
    logger.info(`[${requestId}] implementPlan=true — parsing plan.md (${planContent!.length} chars) into steps`);

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

  // ── Branch B: user question (plan.md irrelevant here) ─────────────────────
  } else {
    logger.info(`[${requestId}] Question mode — selecting files for: "${userQuestion!.substring(0, 80)}"`);

    writer.writeData({
      type: "progress",
      label: "plan-parse",
      status: "in-progress",
      order: progressCounter.value++,
      message: "Analysing project and identifying files to modify...",
    } satisfies ProgressAnnotation);

    // Step 1: ask LLM which files need touching
    try {
      const batchPlan = await selectFilesForBuild(userQuestion!, files, onUsage);
      selectedFileList = batchPlan.files;
    } catch (err: any) {
      logger.warn(`[${requestId}] File selection failed (${err?.message}), falling back to topic-steps mode`);
      selectedFileList = [];
    }

    logger.info(`[${requestId}] File selector returned ${selectedFileList.length} files`);

    // Step 2: decide execution mode
    if (selectedFileList.length >= FILE_PER_STEP_THRESHOLD) {
      // Large batch: one step per file for full per-file progress visibility
      executionMode = "files";
      steps = await generateFileSteps(userQuestion!, selectedFileList);
      logger.info(`[${requestId}] Execution mode: file-per-step (${steps.length} files >= threshold ${FILE_PER_STEP_THRESHOLD})`);
    } else {
      // Small/zero file list: use architectural topic steps — LLM reasons holistically
      executionMode = "steps";
      logger.info(`[${requestId}] Execution mode: topic-steps (${selectedFileList.length} files < threshold ${FILE_PER_STEP_THRESHOLD})`);

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

  const isTestRequest = isTestGenerationRequest(userQuestion ?? "");
  if (isTestRequest) {
    logger.info(`[${requestId}] Test generation intent detected — test files will be allowed in execution`);
  }

  let succeededSteps = 0;
  let failedSteps = 0;
  let circuitBroken = false;

  const accumulatedFiles: FileMap = { ...files };

  const executeStep = async (step: PlanStep): Promise<void> => {
    if (!writer.isAlive() || circuitBroken) return;
    if (clientAbortSignal?.aborted) return;

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
        const relevantPaths: string[] = searchWithGraph(query, GRAPH_SEARCH_MAX_FILES, GRAPH_SEARCH_DEPTH);
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
        promptId: isTestRequest ? "plan-test" : "plan",
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
        return;
      }

      const generatedFiles = extractGeneratedFiles(stepText, accumulatedFiles);
      const generatedCount = Object.keys(generatedFiles).length;
      if (generatedCount > 0) {
        Object.assign(accumulatedFiles, generatedFiles);
        logger.info(`[${requestId}] Step ${step.index} produced ${generatedCount} file(s), accumulated state updated`);

        const patches: PatchEntry[] = [];
        for (const [filePath, entry] of Object.entries(generatedFiles)) {
          if (entry && entry.type === 'file' && !entry.isBinary && typeof entry.content === 'string') {
            patches.push({ path: filePath, content: entry.content });
          }
        }
        if (patches.length > 0) {
          try {
            patchIndex(patches);
            logger.info(`[${requestId}] Step ${step.index} index patched with ${patches.length} file(s)`);
          } catch (patchErr: any) {
            logger.warn(`[${requestId}] Step ${step.index} index patch failed (non-fatal): ${patchErr?.message}`);
          }
        }
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
      if (totalAttempted >= CIRCUIT_BREAKER_MIN_ATTEMPTS) {
        const failureRate = failedSteps / totalAttempted;
        if (failureRate >= CIRCUIT_BREAKER_FAILURE_RATE) {
          logger.error(`[${requestId}] Circuit breaker triggered: ${failedSteps}/${totalAttempted} steps failed (${Math.round(failureRate * 100)}%). Aborting plan.`);
          writer.writeData({
            type: "progress",
            label: "plan-error",
            status: "complete",
            order: progressCounter.value++,
            message: `Plan aborted: ${failedSteps} of ${totalAttempted} steps failed. This may indicate an issue with the model or request. Please try again.`,
          } satisfies ProgressAnnotation);
          circuitBroken = true;
        }
      }
    }
  };

  for (const step of steps) {
    if (!writer.isAlive() || circuitBroken) break;
    await executeStep(step);
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

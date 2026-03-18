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
  /\b(write|add|create|generate|run|fix|update)\s+(a\s+)?(unit\s+)?tests?\b/i,
  /\bunit\s+tests?\b/i,
  /\bintegration\s+tests?\b/i,
  /\be2e\s+tests?\b/i,
  /\bend[- ]to[- ]end\s+tests?\b/i,
  /\b(test|spec)\s+file\b/i,
  /\b\.spec\.[tj]sx?\b/i,
  /\b\.test\.[tj]sx?\b/i,
  /\bvitest\b/i,
  /\bjest\b/i,
  /\bcypress\b/i,
  /\bplaywright\b/i,
  /\btest\s+suite\b/i,
  /\btest\s+coverage\b/i,
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
  contextFiles?: FileMap,
  onFinish?: (resp: GenerateTextResult<Record<string, CoreTool<any, any>>, never>) => void,
): Promise<PlanStep[]> {
  logger.info("Parsing PLAN.md into steps via LLM...");

  const existingFileSummary = buildExistingFileSummary(contextFiles);

  const resp = await generateText({
    model: getTachyonModel(),
    system: `
You are a world-class software architect with 30+ years of experience decomposing projects into precise, executable implementation steps.

Your job: read a project plan and produce a clean, ordered list of CODE CHANGE STEPS only.

Return ONLY a valid JSON array — no prose, no markdown fences. Each element must have:
"index"   : number  (1-based sequential integer)
"heading" : string  (concise action-oriented title ≤ 80 chars, starting with a verb: "Add", "Create", "Update", "Implement", "Refactor", "Wire", "Integrate")
"details" : string  (precise implementation guidance covering: what to create/modify, which functions/components/interfaces to write, which patterns to follow, and how this step connects to adjacent steps)

CRITICAL — EXISTING FILE AWARENESS:
When you reference files in "details", you MUST use the exact file paths from the project. Never invent a path that doesn't exist. If you are creating a new file, follow the project's established directory and naming conventions.

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
${existingFileSummary ? `${existingFileSummary}\n\n` : ""}Here is the project plan:

<plan>
${planContent}
</plan>

Use the exact file paths from the project where applicable. Think through the best architecture and zero-overlap execution order, then return the JSON array of code change steps.
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
  contextFiles?: FileMap,
  onFinish?: (resp: GenerateTextResult<Record<string, CoreTool<any, any>>, never>) => void,
): Promise<PlanStep[]> {
  logger.info("Generating implementation steps from user question via LLM...");

  const existingFileSummary = buildExistingFileSummary(contextFiles);

  const resp = await generateText({
    model: getTachyonModel(),
    system: `
You are a world-class software architect with 30+ years of experience. You have an exceptional ability to decompose any feature request into a precise, deeply complete set of code change steps — covering every layer of the stack needed to fully implement the functionality.

Your job: take a user's feature request and produce the optimal ordered list of CODE CHANGE STEPS that will fully implement it, end-to-end, with zero gaps.

Return ONLY a valid JSON array — no prose, no markdown fences. Each element must have:
"index"   : number  (1-based sequential integer)
"heading" : string  (concise action-oriented title ≤ 80 chars, starting with a verb: "Add", "Create", "Update", "Implement", "Refactor", "Wire", "Integrate", "Extend", "Build")
"details" : string  (precise implementation guidance: exact files to create/modify, specific functions/components/types to write, data shapes, API contracts, UI behavior, and how this step integrates with the previous and next steps)

CRITICAL — EXISTING FILE AWARENESS:
When you reference files in "details", you MUST use the exact file paths from the project. If the user asks about a feature that involves an existing file, reference that exact path — never invent a different name. For example, if the project has "src/pages/PhotosPage.tsx" and the user asks to modify the gallery, your step must reference "src/pages/PhotosPage.tsx", NOT "src/pages/GalleryPage.tsx".

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
${existingFileSummary ? `\n${existingFileSummary}\n` : ""}
Think through the optimal architecture and zero-overlap step order that fully implements this request end-to-end. Use the exact file names from the project where applicable. Then return the JSON array of code change steps.
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

function getPackageJsonContent(files: FileMap): string | null {
  for (const [path, entry] of Object.entries(files)) {
    const name = path.split("/").pop()?.toLowerCase();
    if (
      name === "package.json" &&
      entry?.type === "file" &&
      !(entry as any).isBinary &&
      typeof (entry as any).content === "string"
    ) {
      return (entry as any).content;
    }
  }
  return null;
}

function buildPackageJsonStep(
  pkgContent: string,
  planContent: string | null,
  userQuestion: string | undefined,
): PlanStep {
  let projectNameHint = "";

  const nameFromPlan = planContent
    ? (planContent.match(/^#\s+(.+)/m)?.[1]?.trim() ?? planContent.match(/project[:\s]+([A-Za-z0-9 _-]+)/i)?.[1]?.trim())
    : null;

  const nameFromQuestion = userQuestion
    ? userQuestion.match(/(?:app|application|project|site|platform|tool)\s+(?:called|named|for)\s+["']?([A-Za-z0-9 _-]+)["']?/i)?.[1]?.trim()
    : null;

  const inferredName = nameFromPlan || nameFromQuestion;
  if (inferredName) {
    projectNameHint = ` Set the "name" field to "${inferredName.toLowerCase().replace(/\s+/g, "-")}".`;
  }

  let currentDeps: string[] = [];
  try {
    const parsed = JSON.parse(pkgContent);
    currentDeps = [
      ...Object.keys(parsed.dependencies ?? {}),
      ...Object.keys(parsed.devDependencies ?? {}),
    ];
  } catch {
  }

  const currentDepsList = currentDeps.length > 0 ? `\nCurrently installed packages: ${currentDeps.join(", ")}.` : "";

  return {
    index: 1,
    heading: "Update package.json — project name and dependencies",
    details: `Update package.json to reflect this project.${projectNameHint} Review all imports and features described in the plan and add any npm packages that are required but not yet present in dependencies or devDependencies. Do not remove existing packages.${currentDepsList} Output the complete updated package.json file.`,
  };
}

function prependPackageJsonStep(
  steps: PlanStep[],
  files: FileMap,
  planContent: string | null,
  userQuestion: string | undefined,
): PlanStep[] {
  const pkgContent = getPackageJsonContent(files);
  if (!pkgContent) return steps;

  const pkgStep = buildPackageJsonStep(pkgContent, planContent, userQuestion);
  const reindexed = steps.map((s) => ({ ...s, index: s.index + 1 }));
  return [pkgStep, ...reindexed];
}

function buildExistingFileSummary(files?: FileMap): string {
  if (!files || Object.keys(files).length === 0) return "";

  const entries = Object.entries(files)
    .filter(([, entry]) => entry?.type === "file" && !(entry as any).isBinary)
    .map(([path]) => `  - ${path}`);

  if (entries.length === 0) return "";

  return [
    `<existing_project_files>`,
    `The project already contains these files. Reference them by their EXACT paths in your step details:`,
    entries.join("\n"),
    `</existing_project_files>`,
  ].join("\n");
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

function resolveContextFilesForStep(step: PlanStep, accumulatedFiles: FileMap): FileMap {
  const filePath = step.heading;
  const result: FileMap = {};

  const primaryFile = accumulatedFiles[filePath];
  if (primaryFile) {
    result[filePath] = primaryFile;
  } else {
    const fuzzyMatch = fuzzyFindExistingFile(filePath, accumulatedFiles);
    if (fuzzyMatch && accumulatedFiles[fuzzyMatch]) {
      result[fuzzyMatch] = accumulatedFiles[fuzzyMatch];
    }
  }

  if (isTestFile(filePath)) {
    const sourcePath = resolveSourceFileForTest(filePath, accumulatedFiles);
    if (sourcePath && accumulatedFiles[sourcePath]) {
      result[sourcePath] = accumulatedFiles[sourcePath];
    }
  }

  const mentionedPaths = extractMentionedFilePaths(step.details, accumulatedFiles);
  for (const p of mentionedPaths) {
    if (!result[p] && accumulatedFiles[p]) {
      result[p] = accumulatedFiles[p];
    }
  }

  return result;
}

function resolveContextFilesForTopicStep(step: PlanStep, files: FileMap): FileMap {
  const result: FileMap = {};
  const searchText = step.heading + " " + step.details;

  const exact = extractMentionedFilePaths(searchText, files);
  for (const p of exact) {
    if (files[p]) result[p] = files[p];
  }

  if (Object.keys(result).length === 0) {
    const words = searchText
      .split(/\s+/)
      .filter((w) => w.length > 6 && /[a-zA-Z]/.test(w))
      .map((w) => w.replace(/[^a-zA-Z0-9_\-./]/g, ""));

    const seen = new Set<string>();
    for (const word of words) {
      if (!word || seen.has(word)) continue;
      seen.add(word);
      const fuzzy = fuzzyFindExistingFile(word, files);
      if (fuzzy && files[fuzzy] && !result[fuzzy]) {
        result[fuzzy] = files[fuzzy];
      }
    }
  }

  return result;
}

function extractMentionedFilePaths(details: string, files: FileMap): string[] {
  const mentioned: string[] = [];
  for (const filePath of Object.keys(files)) {
    const basename = filePath.split("/").pop() ?? "";
    const relativePath = filePath.replace("/home/project/", "");
    const stem = basename.replace(/\.[^.]+$/, "");

    if (details.includes(filePath) || details.includes(relativePath)) {
      mentioned.push(filePath);
      continue;
    }

    if (stem.length > 6 && hasWordBoundaryMatch(details, stem)) {
      mentioned.push(filePath);
    }
  }
  return mentioned;
}

function hasWordBoundaryMatch(text: string, word: string): boolean {
  const normalized = word
    .replace(/([a-z])([A-Z])/g, "$1[\\s_\\-]?$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1[\\s_\\-]?$2");
  try {
    const re = new RegExp(`(?<![a-zA-Z])${normalized}(?![a-zA-Z])`, "i");
    return re.test(text);
  } catch {
    return text.toLowerCase().includes(word.toLowerCase());
  }
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
  accumulatedFiles?: FileMap,
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

  const existingFileContext = buildStepFileContext(step, accumulatedFiles);

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
        existingFileContext,
        ``,
        remainingSteps
          ? `## Do NOT implement yet (upcoming steps):\n${remainingSteps}`
          : `## This is the FINAL step - complete the implementation.`,
        ``,
        STEP_EXECUTION_INSTRUCTIONS(step.index),
      ].filter(Boolean).join("\n"),
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
        existingFileContext,
        ``,
        remainingSteps
          ? `## Do NOT implement yet (upcoming steps):\n${remainingSteps}`
          : `## This is the ONLY step - complete the full implementation.`,
        ``,
        STEP_EXECUTION_INSTRUCTIONS(step.index),
      ].filter(Boolean).join("\n"),
    } as any);
  }

  return stepMessages;
}

function buildStepFileContext(step: PlanStep, files?: FileMap): string {
  if (!files || Object.keys(files).length === 0) return "";

  let mentionedPaths = extractMentionedFilePaths(step.details + " " + step.heading, files);

  if (mentionedPaths.length === 0) {
    const words = (step.heading + " " + step.details)
      .split(/\s+/)
      .filter((w) => w.length > 6 && /[a-zA-Z]/.test(w));
    const seen = new Set<string>();
    for (const word of words) {
      const clean = word.replace(/[^a-zA-Z0-9_\-./]/g, "");
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      const fuzzy = fuzzyFindExistingFile(clean, files);
      if (fuzzy && !mentionedPaths.includes(fuzzy)) {
        mentionedPaths.push(fuzzy);
      }
    }
  }

  if (mentionedPaths.length === 0) return "";

  const sections: string[] = [`\n## Existing file contents for this step (modify these, do not recreate from scratch):`];

  for (const filePath of mentionedPaths) {
    const entry = files[filePath];
    if (!entry || entry.type !== "file" || (entry as any).isBinary) continue;
    sections.push(`\n### ${filePath}\n\`\`\`\n${(entry as any).content}\n\`\`\``);
  }

  return sections.length > 1 ? sections.join("\n") : "";
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

  const fuzzyMatch = !existingFile ? fuzzyFindExistingFile(filePath, files) : null;

  const resolvedExistingFile = existingFile ?? (fuzzyMatch ? files[fuzzyMatch] : undefined);
  const resolvedFilePath = existingFile ? filePath : (fuzzyMatch ?? filePath);

  let fileContext: string;
  if (resolvedExistingFile && resolvedExistingFile.type === "file" && !resolvedExistingFile.isBinary) {
    fileContext = fuzzyMatch
      ? `\n\nNOTE: The step references "${filePath}" but the project has "${resolvedFilePath}". Treat them as the same file.\n\nCurrent content of ${resolvedFilePath}:\n\`\`\`\n${resolvedExistingFile.content}\n\`\`\``
      : `\n\nCurrent content of ${filePath}:\n\`\`\`\n${resolvedExistingFile.content}\n\`\`\``;
  } else {
    fileContext = `\n\n${filePath} does not exist yet — create it from scratch.`;
  }

  const sourceFileContext = (() => {
    if (!isTestFile(filePath)) return "";
    const sourcePath = resolveSourceFileForTest(filePath, files);
    if (!sourcePath) return "";
    const sourceFile = files[sourcePath];
    if (!sourceFile || sourceFile.type !== "file" || sourceFile.isBinary) return "";
    return `\n\n## Source file under test — ${sourcePath}:\n\`\`\`\n${(sourceFile as any).content}\n\`\`\``;
  })();

  const relatedFilesContext = (() => {
    const mentioned = extractMentionedFilePaths(step.details, files);
    const related = mentioned.filter(
      (p) => p !== resolvedFilePath && p !== filePath && (
        !isTestFile(filePath) || !resolveSourceFileForTest(filePath, files) || p !== resolveSourceFileForTest(filePath, files)
      ),
    );
    if (related.length === 0) return "";
    const parts = related
      .map((p) => {
        const e = files[p];
        if (!e || e.type !== "file" || (e as any).isBinary) return "";
        return `\n### Related: ${p}\n\`\`\`\n${(e as any).content}\n\`\`\``;
      })
      .filter(Boolean);
    return parts.length > 0 ? `\n\n## Related files for context:\n${parts.join("\n")}` : "";
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
      `File: ${resolvedFilePath}`,
      step.details,
      fileContext,
      sourceFileContext,
      relatedFilesContext,
      ``,
      FILE_STEP_EXECUTION_INSTRUCTIONS(resolvedFilePath, !!resolvedExistingFile, userQuestion),
    ]
      .filter(Boolean)
      .join("\n"),
  } as any);

  return stepMessages;
}

function fuzzyFindExistingFile(targetPath: string, files: FileMap): string | null {
  const targetBasename = targetPath.split("/").pop()?.toLowerCase() ?? "";
  const targetStem = targetBasename.replace(/\.[^.]+$/, "");

  if (!targetStem || targetStem.length < 3) return null;

  let bestMatch: string | null = null;
  let bestScore = 0;

  for (const existingPath of Object.keys(files)) {
    const existingBasename = existingPath.split("/").pop()?.toLowerCase() ?? "";
    const existingStem = existingBasename.replace(/\.[^.]+$/, "");

    const score = stemSimilarity(targetStem, existingStem);
    if (score > bestScore && score >= 0.6) {
      bestScore = score;
      bestMatch = existingPath;
    }
  }

  return bestMatch;
}

function stemSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const normalize = (s: string) =>
    s
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .toLowerCase()
      .split(/[\s_\-./]+/)
      .filter((t) => t.length > 0);

  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  if (longer.toLowerCase().includes(shorter.toLowerCase())) return shorter.length / longer.length;

  const tokensA = new Set(normalize(a));
  const tokensB = new Set(normalize(b));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  const intersection = [...tokensA].filter((t) => tokensB.has(t));
  const union = new Set([...tokensA, ...tokensB]);
  return intersection.length / union.size;
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

  const totalProjectFiles = Object.keys(files).filter((k) => (files[k] as any)?.type === "file").length;
  logger.info(
    `[${requestId}] ═══ streamPlanResponse START ═══ mode=${usePlanMd ? "plan-md" : "question"} implementPlan=${!!implementPlan} chatMode=${chatMode} projectFiles=${totalProjectFiles} question="${userQuestion?.slice(0, 100) ?? "(none)"}"`,
  );

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
      steps = await parsePlanIntoSteps(planContent!, files, onUsage);
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
    logger.info(`[${requestId}] ► PLAN.MD parsed into ${steps.length} step(s) (context files: ${Object.keys(files).length})`);
    for (const s of steps) {
      logger.info(`[${requestId}]   step ${s.index}: ${s.heading}`);
    }

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

    logger.info(`[${requestId}] ► BATCH PLANNER returned ${selectedFileList.length} file(s) (threshold=${FILE_PER_STEP_THRESHOLD})`);
    for (const f of selectedFileList) {
      logger.info(`[${requestId}]   ↳ ${f.path} — ${f.reason}`);
    }

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
        steps = await generateStepsFromQuestion(userQuestion!, files, onUsage);
        logger.info(`[${requestId}] ► TOPIC STEPS generated: ${steps.length} step(s) (context files: ${Object.keys(files).length})`);
        for (const s of steps) {
          logger.info(`[${requestId}]   step ${s.index}: ${s.heading}`);
          logger.info(`[${requestId}]     details: ${s.details.slice(0, 150)}${s.details.length > 150 ? "…" : ""}`);
        }
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

  steps = prependPackageJsonStep(steps, files, planContent, userQuestion);
  if (steps[0]?.heading === "Update package.json — project name and dependencies") {
    logger.info(`[${requestId}] ► Prepended mandatory package.json step (total steps now: ${steps.length})`);
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

    const stepTag = `[${requestId}][step ${step.index}/${steps.length}]`;

    logger.info(`${stepTag} ─── START ─── "${step.heading}" [mode=${executionMode}]`);
    logger.info(`${stepTag} details: ${step.details.slice(0, 200)}${step.details.length > 200 ? "…" : ""}`);

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
        : buildTopicStepMessages(messages, steps, step, usePlanMd, planContent, userQuestion ?? null, accumulatedFiles);

    let filesToUse: FileMap = accumulatedFiles;
    let contextSource = "full-accumulated";

    if (executionMode === "files") {
      filesToUse = resolveContextFilesForStep(step, accumulatedFiles);
      contextSource = "files-mode-resolved";

      const primaryPath = step.heading;
      const resolvedPrimary = filesToUse[primaryPath]
        ? primaryPath
        : Object.keys(filesToUse).find((p) => p !== primaryPath) ?? "(none)";
      logger.info(`${stepTag} [files-mode] primary file: ${primaryPath}`);
      logger.info(`${stepTag} [files-mode] resolved to: ${resolvedPrimary}`);
      if (isTestFile(primaryPath)) {
        const srcPath = resolveSourceFileForTest(primaryPath, accumulatedFiles);
        logger.info(`${stepTag} [files-mode] is test file → source: ${srcPath ?? "(not found)"}`);
      }
    } else {
      let graphSearchHit = false;
      try {
        const query = `${step.heading} ${step.details}`;
        const relevantPaths: string[] = searchWithGraph(query, GRAPH_SEARCH_MAX_FILES, GRAPH_SEARCH_DEPTH);
        logger.info(`${stepTag} [graph-search] query="${query.slice(0, 100)}…" → ${relevantPaths.length} hit(s)`);

        if (relevantPaths.length > 0) {
          const stepFiles: FileMap = {};
          const matched: string[] = [];
          const missed: string[] = [];
          for (const relPath of relevantPaths) {
            const fullPath = `/home/project/${relPath}`;
            if (Object.prototype.hasOwnProperty.call(accumulatedFiles, fullPath)) {
              stepFiles[fullPath] = accumulatedFiles[fullPath];
              matched.push(fullPath);
            } else {
              missed.push(fullPath);
            }
          }
          if (matched.length > 0) logger.info(`${stepTag} [graph-search] matched in accumulated (${matched.length}): ${matched.join(", ")}`);
          if (missed.length > 0) logger.warn(`${stepTag} [graph-search] graph hit but NOT in accumulated (${missed.length}): ${missed.join(", ")}`);

          if (Object.keys(stepFiles).length > 0) {
            filesToUse = stepFiles;
            graphSearchHit = true;
            contextSource = "graph-search";
          }
        } else {
          logger.warn(`${stepTag} [graph-search] returned 0 results — falling back to keyword context`);
        }
      } catch (gErr: any) {
        logger.warn(`${stepTag} [graph-search] unavailable (${gErr?.message ?? "unknown error"}) — falling back to keyword context`);
      }

      if (!graphSearchHit) {
        const keywordFiles = resolveContextFilesForTopicStep(step, accumulatedFiles);
        if (Object.keys(keywordFiles).length > 0) {
          filesToUse = keywordFiles;
          contextSource = "keyword-fallback";
          logger.info(`${stepTag} [keyword-fallback] found ${Object.keys(keywordFiles).length} file(s): ${Object.keys(keywordFiles).join(", ")}`);
        } else {
          contextSource = "full-accumulated";
          logger.warn(`${stepTag} [keyword-fallback] no targeted context found → using full accumulated set (${Object.keys(accumulatedFiles).length} files)`);
        }
      }
    }

    const contextFileList = Object.keys(filesToUse);
    logger.info(
      `${stepTag} ► CONTEXT SENT TO LLM [source=${contextSource}] — ${contextFileList.length} file(s) / ${Object.keys(accumulatedFiles).length} accumulated total`,
    );
    for (const fp of contextFileList) {
      const entry = filesToUse[fp] as any;
      const chars = typeof entry?.content === "string" ? entry.content.length : 0;
      logger.info(`${stepTag}   ↳ ${fp} (${chars} chars)`);
    }

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
        logger.warn(`${stepTag} ✗ FAILED (all retries exhausted), skipping file extraction`);
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
        logger.info(`${stepTag} ► LLM OUTPUT — ${generatedCount} file(s) generated:`);
        for (const [fp, entry] of Object.entries(generatedFiles)) {
          const chars = typeof (entry as any)?.content === "string" ? (entry as any).content.length : 0;
          logger.info(`${stepTag}   ↳ ${fp} (${chars} chars)`);
        }

        const patches: PatchEntry[] = [];
        for (const [filePath, entry] of Object.entries(generatedFiles)) {
          if (entry && entry.type === 'file' && !entry.isBinary && typeof entry.content === 'string') {
            patches.push({ path: filePath, content: entry.content });
          }
        }
        if (patches.length > 0) {
          try {
            patchIndex(patches);
            logger.info(`${stepTag} [index] patched with ${patches.length} file(s)`);
          } catch (patchErr: any) {
            logger.warn(`${stepTag} [index] patch failed (non-fatal): ${patchErr?.message}`);
          }
        }
      } else {
        logger.warn(`${stepTag} ► LLM OUTPUT — 0 files extracted (no <cortexAction type="file"> blocks found in response)`);
      }

      if (!writer.isAlive()) {
        logger.warn(`${stepTag} client disconnected after step output, aborting`);
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

      logger.info(`${stepTag} ─── DONE ─── succeeded=${succeededSteps} failed=${failedSteps}`);
    } catch (err: any) {
      logger.error(`${stepTag} ✗ ERROR: ${err?.message}`, err);

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
    `[${requestId}] ═══ PLAN COMPLETE ═══ steps=${steps.length} succeeded=${succeededSteps} failed=${failedSteps} circuitBroken=${circuitBroken} totalTokens=${cumulativeUsage.totalTokens} promptTokens=${cumulativeUsage.promptTokens} completionTokens=${cumulativeUsage.completionTokens}`,
  );

  writer.writeData({
    type: "progress",
    label: "plan-complete",
    status: "complete",
    order: progressCounter.value++,
    message: `Implementation complete: ${succeededSteps}/${steps.length} step${steps.length !== 1 ? "s" : ""} executed${failedSteps > 0 ? `, ${failedSteps} failed` : ""}`,
  } satisfies ProgressAnnotation);
}

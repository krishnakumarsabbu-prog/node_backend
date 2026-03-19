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
import { validateStep } from "./agents/step-validator";
import { injectMissingDependencies, extractPackageJson } from "./agents/dependency-injector";
import { scoreExecution, PASS_THRESHOLD } from "./agents/execution-scorer";
import { repairStep, SELF_HEAL_MAX_ATTEMPTS } from "./agents/self-healing-loop";
import { buildSequentialExecutionPlan } from "./agents/sequential-executor";
import { runPlanSanityCheck, injectSymbolWarningsIntoSteps } from "./agents/plan-sanity";
import { buildStepSymbolSummaries, buildSymbolContextBlock } from "./agents/symbol-extractor";
import { checkCompleteness } from "./agents/completeness-checker";

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

export interface CompletedStepMemory {
  index: number;
  heading: string;
  filesProduced: string[];
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
You are a world-class software architect with 30+ years of experience. Your job: read a project plan and produce a lean, ordered list of CODE CHANGE STEPS that deliver fully working, integrated functionality.

Return ONLY a valid JSON array — no prose, no markdown fences. Each element must have:
"index"   : number  (1-based sequential integer)
"heading" : string  (concise action-oriented title ≤ 80 chars, starting with a verb: "Implement", "Build", "Add", "Wire", "Integrate", "Create", "Update", "Extend")
"details" : string  (comprehensive implementation guidance: exact files to create/modify, specific functions/components/types, data shapes, API contracts, UI behavior, dependency wiring, integration points — must include inputs, processing logic, outputs, and dependency declarations)

CRITICAL — PLAN INTERPRETATION:
The plan may use fine-grained checklist items, tasks, or sub-items. IGNORE that granularity entirely.
Group related checklist items into higher-level feature implementations.
Each step represents a COMPLETE FEATURE, not individual checklist items or sub-tasks.

CRITICAL — EXISTING FILE AWARENESS:
When referencing files in "details", use the exact file paths from the project. Never invent a path that does not exist. For new files, follow the project's established directory and naming conventions.

STEP SIZE CONSTRAINT (HARD RULE):
- Each step MUST produce between 2 and 8 files (create or meaningfully modify)
- A step that touches only 1 file is almost always TOO SMALL — merge it with adjacent related steps
- A step that touches more than 8 files is probably TOO LARGE — split by feature boundary only
- Target: 3–6 meaningful file changes per step

FEATURE GROUPING RULE (HARD RULE):
- Each step must correspond to ONE complete user-facing feature or backend capability
- A full feature includes ALL of: data model + business logic + API (if applicable) + UI + routing (if applicable)
- Do NOT split a feature across multiple steps by technical layer (no "service step" then "UI step" for the same feature)
- Only split by feature boundary — not by technical layer

STEP COMPLEXITY RULE:
- Each step should represent roughly equal implementation effort
- Avoid extremely small steps (single file, single method) — these indicate fragmentation
- Avoid extremely large steps (entire application) — these indicate missed feature boundaries
- Ask: would a skilled developer implement this step in a single focused coding session?

FEATURE EXTRACTION LAYER — Before producing steps, do this mental decomposition:
1. Identify all FEATURE-LEVEL modules in the plan (e.g., Authentication, Dashboard, Orders — NOT atomic tasks)
2. For each feature, define:
   - Inputs: what API endpoints, forms, or user actions trigger it
   - Processing: what services, business rules, or transformations it applies
   - Outputs: what UI renders, what API response is returned, what state changes
   - Dependencies: what libraries, frameworks, external services it needs
3. Map each feature to 1-N steps — each step = one complete, usable capability
4. Do NOT break a feature into micro-tasks (e.g., "create file", "add method", "wire import")
5. Group related tasks that only make sense together into a SINGLE step

ARCHITECTURE DESIGN FIRST — Before splitting into steps, mentally answer:
1. What are the complete FEATURE-LEVEL capabilities? What does "done" look like for each?
2. How can each step deliver a fully working, testable vertical slice — not just isolated code?
3. What is the dependency order? Foundation layers (types, auth, config) before features that use them?
4. Which files will multiple features need to touch? (router, sidebar, app config — plan for incremental updates)

PRIMARY RULE:
Each step MUST produce fully working, integrated, and usable functionality. Avoid partial implementations. Prefer vertical slices (feature-complete) over horizontal slices (layer-only). A step that creates a service without wiring it to anything is NOT acceptable.

OVERLAP RULE:
- Steps may modify the same file if necessary, but each modification must be additive and non-conflicting with previous steps
- Do NOT merge unrelated features into a single step just because they touch the same file

CONSISTENCY RULE:
- Follow a consistent architectural pattern across all steps (naming conventions, folder structure, API design, error handling style)
- Reuse patterns and utilities introduced in earlier steps — never introduce a parallel approach to something already established
- Do not duplicate configuration or redefine shared utilities that already exist

STEP LINKING RULE:
- Each step must explicitly build on outputs from previous steps
- Reference previously created services, hooks, types, and components by name
- Do not redefine entities already created in earlier steps — extend or import them

DEPENDENCY ORDER RULE:
- A step must NOT reference any file, API, type, or component that has not been created by a previous step or within the same step
- If a dependency is required, ensure it is created in an earlier step — never forward-reference

MODIFICATION RULE:
- Prefer updating and extending existing files over creating new parallel implementations
- When modifying a file, clearly specify what to add, where, and why it is needed
- Avoid creating duplicate implementations of the same responsibility

ANTI-FRAGMENTATION RULE:
- Do NOT split a feature into multiple steps unless it is genuinely too large to implement coherently in one step
- Prefer fewer, complete steps over many partial steps
- Wiring, routing, and integration belong in the same step as the feature they connect — not a separate "Wire X" step unless unavoidable

STEP RULES:
- Include ONLY source code change steps — no documentation, no tests, no README updates
- Each step must produce complete, compilable, runnable code with no missing imports or undefined references
- Every UI component created must be connected to routing/navigation in the same step
- Every API endpoint created must be connected to its service layer in the same step
- Every service must be consumed by at least one upstream component — no orphan services
- If a step introduces new dependencies, it MUST update the build manifest (package.json / pom.xml / build.gradle) in the same step
- Avoid skeleton, stub, or placeholder implementations — every file must be complete and functional

DEFINITION OF DONE (each step must satisfy ALL of these):
- Code compiles with no errors
- All imports are resolved — no references to files that do not exist yet
- No unused or unreachable components
- Every created component is wired and reachable from the application entry point
- Feature is usable end-to-end, not just scaffolded

FORBIDDEN:
- Skeleton code or empty method bodies
- Placeholder UI (headers only, "coming soon" content)
- TODO comments in generated code
- Orphan components that are created but never used
- Documentation / README / JSDoc / comments steps
- Test files / unit tests / integration tests / e2e tests steps
- Linting / formatting / deployment / CI/CD steps
- Steps that produce only 1 file (except for foundation/config steps that must stand alone)

OUTPUT: JSON array only. No explanation. No fences.
`,
    prompt: `
${existingFileSummary ? `${existingFileSummary}\n\n` : ""}Here is the project plan:

<plan>
${planContent}
</plan>

IMPORTANT: Ignore the plan's fine-grained task breakdown. Group checklist items into complete feature implementations. Each step must touch 2–8 files and deliver one complete, usable feature end-to-end. Return the JSON array of code change steps.
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
You are a world-class software architect with 30+ years of experience. Your job: take a user's feature request and produce the optimal ordered list of CODE CHANGE STEPS that deliver fully working, integrated functionality — end-to-end, with zero gaps.

Return ONLY a valid JSON array — no prose, no markdown fences. Each element must have:
"index"   : number  (1-based sequential integer)
"heading" : string  (concise action-oriented title ≤ 80 chars, starting with a verb: "Implement", "Build", "Add", "Wire", "Integrate", "Create", "Update", "Extend")
"details" : string  (comprehensive implementation guidance: exact files to create/modify, specific functions/components/types, data shapes, API contracts, UI behavior, dependency wiring, integration points — must include inputs, processing logic, outputs, dependency declarations, and all UI states: loading/empty/error/success)

CRITICAL — EXISTING FILE AWARENESS:
When referencing files in "details", use the exact file paths from the project. If the request involves an existing file, reference that exact path — never invent a different name. For new files, follow the project's established directory and naming conventions.

STEP SIZE CONSTRAINT (HARD RULE):
- Each step MUST produce between 2 and 8 files (create or meaningfully modify)
- A step that touches only 1 file is almost always TOO SMALL — merge it with adjacent related steps
- A step that touches more than 8 files is probably TOO LARGE — split by feature boundary only
- Target: 3–6 meaningful file changes per step
- Exception: the first foundation step (types, config, shared utils) may touch fewer files if genuinely standalone

FEATURE GROUPING RULE (HARD RULE):
- Each step must correspond to ONE complete user-facing feature or backend capability
- A full feature includes ALL of: data model + business logic + API (if applicable) + UI + routing (if applicable)
- Do NOT split a feature across multiple steps by technical layer (no "service step" then "UI step" for the same feature)
- Only split by feature boundary — not by technical layer

STEP COMPLEXITY RULE:
- Each step should represent roughly equal implementation effort
- Avoid extremely small steps (single file, single method) — these indicate fragmentation
- Avoid extremely large steps (entire application at once) — these indicate missed feature boundaries
- Ask: would a skilled developer implement this in a single focused coding session?

FEATURE EXTRACTION LAYER — Before producing steps, do this mental decomposition:
1. Identify all FEATURE-LEVEL modules the request implies (complete capabilities, not atomic tasks)
2. For each feature, define:
   - Inputs: what API endpoints, forms, or user actions trigger it
   - Processing: what services, business rules, or transformations it applies
   - Outputs: what UI renders, what API response is returned, what state changes
   - Dependencies: what libraries, frameworks, external services it needs
3. Map each feature to 1-N steps — each step = one complete, usable capability
4. Do NOT break a feature into micro-tasks (e.g., "create file", "add method", "wire import")
5. Group related tasks that only make sense together into a SINGLE step

ARCHITECTURE DESIGN FIRST — run this mental checklist:
1. What are the complete FEATURE-LEVEL capabilities? What does "done" look like for each?
2. How can each step deliver a fully working, usable vertical slice — not just isolated code?
3. What is the correct dependency order? Foundation types, auth, config before features that use them.
4. Which files will multiple features touch? (router, sidebar, app config — plan for incremental updates)
5. Is the feature fully covered? Every user-facing behavior, data flow, and UI state must be handled.

PRIMARY RULE:
Each step MUST produce fully working, integrated, and usable functionality. Avoid partial implementations. Prefer vertical slices (feature-complete) over horizontal slices (layer-only). A step that creates a service without wiring it to anything is NOT acceptable.

OVERLAP RULE:
- Steps may modify the same file if necessary, but each modification must be additive and non-conflicting with previous steps
- Do NOT merge unrelated features into a single step just because they touch the same file

CONSISTENCY RULE:
- Follow a consistent architectural pattern across all steps (naming conventions, folder structure, API design, error handling style)
- Reuse patterns and utilities introduced in earlier steps — never introduce a parallel approach to something already established
- Do not duplicate configuration or redefine shared utilities that already exist

STEP LINKING RULE:
- Each step must explicitly build on outputs from previous steps
- Reference previously created services, hooks, types, and components by name
- Do not redefine entities already created in earlier steps — extend or import them

DEPENDENCY ORDER RULE:
- A step must NOT reference any file, API, type, or component that has not been created by a previous step or within the same step
- If a dependency is required, ensure it is created in an earlier step — never forward-reference

MODIFICATION RULE:
- Prefer updating and extending existing files over creating new parallel implementations
- When modifying a file, clearly specify what to add, where, and why it is needed
- Avoid creating duplicate implementations of the same responsibility

ANTI-FRAGMENTATION RULE:
- Do NOT split a feature into multiple steps unless it is genuinely too large to implement coherently in one step
- Prefer fewer, complete steps over many partial steps
- Wiring, routing, and integration belong in the same step as the feature they connect — not a separate "Wire X" step unless unavoidable

STEP RULES:
- Include ONLY source code change steps — no documentation, no tests, no README updates
- Each step must produce complete, compilable, runnable code with no missing imports or undefined references
- Order steps in strict dependency order — no step should require code from a later step
- Prefer feature-based (vertical) steps: a step may span data model + service + API + UI + routing if they together implement one coherent feature
- Avoid splitting steps purely by technical layer (service alone, controller alone, UI alone) when those pieces only make sense together
- Every UI component created must be connected to routing/navigation in the same step
- Every API endpoint created must be connected to its service layer in the same step
- Every service must be consumed by at least one upstream component — no orphan services
- If a step introduces new dependencies, it MUST update the build manifest (package.json / pom.xml / build.gradle) in the same step
- All UI states must be handled: loading, empty, error, success
- Avoid skeleton, stub, or placeholder implementations — every file must be complete and functional

DEFINITION OF DONE (each step must satisfy ALL of these):
- Code compiles with no errors
- All imports are resolved — no references to files that do not exist yet
- No unused or unreachable components
- Every created component is wired and reachable from the application entry point
- Feature is usable end-to-end, not just scaffolded

FORBIDDEN:
- Skeleton code or empty method bodies
- Placeholder UI (headers only, "coming soon" content)
- TODO comments in generated code
- Orphan components that are created but never used
- Documentation / README / JSDoc / comments steps
- Test files / unit tests / integration tests / e2e tests steps
- Linting / formatting / deployment / CI/CD steps
- Steps that produce only 1 file (except standalone foundation/config steps)

OUTPUT: JSON array only. No explanation text. No markdown fences. No preamble.
`,
    prompt: `
User's request:

<request>
${userQuestion}
</request>
${existingFileSummary ? `\n${existingFileSummary}\n` : ""}
Think through what each feature needs to be complete and usable end-to-end. Each step must touch 2–8 files and deliver one complete feature. Use the exact file names from the project where applicable. Return the JSON array of code change steps.
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

type ProjectEcosystem =
  | "node"       // package.json  — npm / yarn / pnpm
  | "java-maven" // pom.xml       — Maven
  | "java-gradle"// build.gradle / build.gradle.kts — Gradle
  | "python"     // requirements.txt / pyproject.toml / Pipfile
  | "rust"       // Cargo.toml
  | "go"         // go.mod
  | "dotnet"     // *.csproj / *.fsproj / *.vbproj
  | "ruby"       // Gemfile
  | "php"        // composer.json
  | "swift"      // Package.swift / *.podspec
  | "dart"       // pubspec.yaml
  | "elixir"     // mix.exs
  | "haskell";   // *.cabal / package.yaml

interface DetectedManifest {
  ecosystem: ProjectEcosystem;
  path: string;
  content: string;
}

const MANIFEST_DETECTORS: Array<{
  ecosystem: ProjectEcosystem;
  match: (filename: string) => boolean;
}> = [
  { ecosystem: "node",        match: (f) => f === "package.json" },
  { ecosystem: "java-maven",  match: (f) => f === "pom.xml" },
  { ecosystem: "java-gradle", match: (f) => f === "build.gradle" || f === "build.gradle.kts" },
  { ecosystem: "python",      match: (f) => f === "pyproject.toml" || f === "requirements.txt" || f === "pipfile" },
  { ecosystem: "rust",        match: (f) => f === "cargo.toml" },
  { ecosystem: "go",          match: (f) => f === "go.mod" },
  { ecosystem: "dotnet",      match: (f) => f.endsWith(".csproj") || f.endsWith(".fsproj") || f.endsWith(".vbproj") },
  { ecosystem: "ruby",        match: (f) => f === "gemfile" },
  { ecosystem: "php",         match: (f) => f === "composer.json" },
  { ecosystem: "swift",       match: (f) => f === "package.swift" || f.endsWith(".podspec") },
  { ecosystem: "dart",        match: (f) => f === "pubspec.yaml" },
  { ecosystem: "elixir",      match: (f) => f === "mix.exs" },
  { ecosystem: "haskell",     match: (f) => f.endsWith(".cabal") || f === "package.yaml" },
];

function detectProjectManifest(files: FileMap): DetectedManifest | null {
  for (const detector of MANIFEST_DETECTORS) {
    for (const [path, entry] of Object.entries(files)) {
      const filename = path.split("/").pop()?.toLowerCase() ?? "";
      if (
        detector.match(filename) &&
        entry?.type === "file" &&
        !(entry as any).isBinary &&
        typeof (entry as any).content === "string"
      ) {
        return { ecosystem: detector.ecosystem, path, content: (entry as any).content };
      }
    }
  }
  return null;
}

function inferProjectName(
  planContent: string | null,
  userQuestion: string | undefined,
): string | null {
  const nameFromPlan = planContent
    ? (planContent.match(/^#\s+(.+)/m)?.[1]?.trim() ??
       planContent.match(/project[:\s]+([A-Za-z0-9 _-]+)/i)?.[1]?.trim())
    : null;

  const nameFromQuestion = userQuestion
    ? userQuestion.match(
        /(?:app|application|project|site|platform|tool|service|api|library|module)\s+(?:called|named|for)\s+["']?([A-Za-z0-9 _-]+)["']?/i,
      )?.[1]?.trim()
    : null;

  return nameFromPlan ?? nameFromQuestion ?? null;
}

const ECOSYSTEM_LABELS: Record<ProjectEcosystem, string> = {
  "node":        "npm/yarn",
  "java-maven":  "Maven",
  "java-gradle": "Gradle",
  "python":      "pip/Poetry",
  "rust":        "Cargo",
  "go":          "Go modules",
  "dotnet":      ".NET",
  "ruby":        "Bundler",
  "php":         "Composer",
  "swift":       "Swift Package Manager / CocoaPods",
  "dart":        "pub",
  "elixir":      "Mix",
  "haskell":     "Cabal/Stack",
};

function buildManifestStepDetails(
  manifest: DetectedManifest,
  inferredName: string | null,
): string {
  const label = ECOSYSTEM_LABELS[manifest.ecosystem];
  const nameSlug = inferredName
    ? inferredName.toLowerCase().replace(/\s+/g, manifest.ecosystem === "java-maven" || manifest.ecosystem === "java-gradle" ? "" : "-")
    : null;

  const namePart = nameSlug
    ? ` Set the project name / artifactId to "${nameSlug}".`
    : "";

  const ecosystemInstructions: Record<ProjectEcosystem, string> = {
    "node": `Update ${manifest.path}.${namePart} Review the plan and add any missing npm packages to dependencies or devDependencies. Do not remove existing packages. Output the complete updated ${manifest.path}.`,
    "java-maven": `Update ${manifest.path} (Maven POM).${namePart} Review the plan and add any missing <dependency> entries in <dependencies>. Preserve the existing groupId, version, and plugin configuration. Output the complete updated pom.xml.`,
    "java-gradle": `Update ${manifest.path} (Gradle build file).${namePart} Review the plan and add any missing implementation/api/testImplementation dependencies in the dependencies block. Do not remove existing entries. Output the complete updated ${manifest.path}.`,
    "python": `Update ${manifest.path}.${namePart} Review the plan and add any missing Python packages (pip-compatible specifiers). For pyproject.toml, add to [project] dependencies or [tool.poetry.dependencies]. For requirements.txt, append new lines. Do not remove existing packages. Output the complete updated ${manifest.path}.`,
    "rust": `Update Cargo.toml.${namePart} Review the plan and add any missing crate dependencies under [dependencies] or [dev-dependencies]. Preserve existing versions. Output the complete updated Cargo.toml.`,
    "go": `Update go.mod.${namePart} Review the plan and add any missing module require directives. Output the complete updated go.mod. Also list any new imports that will need \`go get\` to resolve.`,
    "dotnet": `Update ${manifest.path} (.NET project file).${namePart} Review the plan and add any missing <PackageReference> entries. Preserve existing package versions and project settings. Output the complete updated ${manifest.path}.`,
    "ruby": `Update Gemfile.${namePart} Review the plan and add any missing gem declarations. Do not remove existing gems. Output the complete updated Gemfile.`,
    "php": `Update composer.json.${namePart} Review the plan and add any missing packages to require or require-dev. Preserve existing constraints. Output the complete updated composer.json.`,
    "swift": `Update ${manifest.path}.${namePart} Review the plan and add any missing Swift package dependencies or pod entries. Output the complete updated ${manifest.path}.`,
    "dart": `Update pubspec.yaml.${namePart} Review the plan and add any missing packages under dependencies or dev_dependencies. Preserve existing version constraints. Output the complete updated pubspec.yaml.`,
    "elixir": `Update mix.exs.${namePart} Review the plan and add any missing {:package, "~> version"} entries in the deps/0 function. Output the complete updated mix.exs.`,
    "haskell": `Update ${manifest.path}.${namePart} Review the plan and add any missing build-depends entries. Output the complete updated ${manifest.path}.`,
  };

  return ecosystemInstructions[manifest.ecosystem];
}

function buildManifestStep(
  manifest: DetectedManifest,
  planContent: string | null,
  userQuestion: string | undefined,
): PlanStep {
  const inferredName = inferProjectName(planContent, userQuestion);
  const label = ECOSYSTEM_LABELS[manifest.ecosystem];

  return {
    index: 1,
    heading: `Update ${manifest.path} — project name and ${label} dependencies`,
    details: buildManifestStepDetails(manifest, inferredName),
  };
}

const DEPENDENCY_SIGNAL_PATTERNS = [
  /\binstall\b/i,
  /\bnew\s+package\b/i,
  /\badd\s+(dependency|dep|library|lib|package)\b/i,
  /\bnpm\s+install\b/i,
  /\byarn\s+add\b/i,
  /\bpnpm\s+add\b/i,
  /\bimport\s+from\s+["'][^./]/i,
  /\brequire\(['"][^./]/i,
  /new\s+feature/i,
  /\bfrom\s+scratch\b/i,
  /\bnew\s+(app|application|project|site)\b/i,
  /\bintegrat(e|ion)\b/i,
];

function planLikelyNeedsNewDependencies(
  planContent: string | null,
  userQuestion: string | undefined,
): boolean {
  const text = `${planContent ?? ""} ${userQuestion ?? ""}`.toLowerCase();
  return DEPENDENCY_SIGNAL_PATTERNS.some((re) => re.test(text));
}

function prependPackageJsonStep(
  steps: PlanStep[],
  files: FileMap,
  planContent: string | null,
  userQuestion: string | undefined,
): PlanStep[] {
  const manifest = detectProjectManifest(files);
  if (!manifest) return steps;

  if (!planLikelyNeedsNewDependencies(planContent, userQuestion)) {
    return steps;
  }

  const manifestStep = buildManifestStep(manifest, planContent, userQuestion);
  const reindexed = steps.map((s) => ({ ...s, index: s.index + 1 }));
  return [manifestStep, ...reindexed];
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

function buildCreatedFilesFeedback(originalFiles: FileMap, accumulatedFiles: FileMap): string {
  const originalPaths = new Set(Object.keys(originalFiles));
  const created = Object.keys(accumulatedFiles).filter((p) => !originalPaths.has(p));
  if (created.length === 0) return "";
  return [
    `\n## Files already created in previous steps (available to import/reference):`,
    created.map((p) => `  - ${p}`).join("\n"),
  ].join("\n");
}

function buildStepMemoryContext(
  completedSteps: CompletedStepMemory[],
  accumulatedFiles?: FileMap,
): string {
  if (completedSteps.length === 0) return "";

  const lines: string[] = [
    `\n## Completed Steps — What Already Exists (DO NOT recreate or redefine these)`,
  ];

  for (const s of completedSteps) {
    lines.push(`\n### Step ${s.index}: ${s.heading}`);
    if (s.filesProduced.length > 0) {
      lines.push(`Files produced:`);
      for (const f of s.filesProduced) {
        lines.push(`  - ${f.replace("/home/project/", "")}`);
      }
    } else {
      lines.push(`  (no file changes detected)`);
    }
  }

  if (accumulatedFiles) {
    const symbolSummaries = buildStepSymbolSummaries(completedSteps, accumulatedFiles);
    const symbolContext = buildSymbolContextBlock(symbolSummaries);
    if (symbolContext) {
      lines.push(symbolContext);
    }
  }

  lines.push(
    ``,
    `MEMORY RULES:`,
    `- Extend and import from the files listed above — do NOT rewrite or duplicate them`,
    `- Use the same naming conventions, patterns, and folder structure established above`,
    `- If a service, hook, type, or component already exists above, reuse it — never redefine it`,
    `- If you need to modify a file from a previous step to wire this step, output the full updated file`,
  );

  return lines.join("\n");
}

function buildTopicStepMessages(
  messages: Messages,
  steps: PlanStep[],
  step: PlanStep,
  usePlanMd: boolean,
  planContent: string | null,
  userQuestion: string | null,
  accumulatedFiles?: FileMap,
  originalFiles?: FileMap,
  completedSteps?: CompletedStepMemory[],
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
  const createdFilesFeedback = originalFiles && accumulatedFiles
    ? buildCreatedFilesFeedback(originalFiles, accumulatedFiles)
    : "";
  const stepMemoryContext = completedSteps ? buildStepMemoryContext(completedSteps, accumulatedFiles) : "";

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
        createdFilesFeedback,
        stepMemoryContext,
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

  const sourceFilesForTests: string[] = [];
  for (const filePath of mentionedPaths) {
    if (isTestFile(filePath)) {
      const sourcePath = resolveSourceFileForTest(filePath, files);
      if (sourcePath && !mentionedPaths.includes(sourcePath) && !sourceFilesForTests.includes(sourcePath)) {
        sourceFilesForTests.push(sourcePath);
      }
    }
  }

  const sections: string[] = [`\n## Existing file contents for this step (modify these, do not recreate from scratch):`];

  for (const filePath of mentionedPaths) {
    const entry = files[filePath];
    if (!entry || entry.type !== "file" || (entry as any).isBinary) continue;
    sections.push(`\n### ${filePath}\n\`\`\`\n${(entry as any).content}\n\`\`\``);
  }

  if (sourceFilesForTests.length > 0) {
    sections.push(`\n## Source files under test (reference these for comprehensive test coverage):`);
    for (const filePath of sourceFilesForTests) {
      const entry = files[filePath];
      if (!entry || entry.type !== "file" || (entry as any).isBinary) continue;
      sections.push(`\n### ${filePath}\n\`\`\`\n${(entry as any).content}\n\`\`\``);
    }
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
    let fileSelectionFailed = false;
    try {
      const batchPlan = await selectFilesForBuild(userQuestion!, files, onUsage);
      selectedFileList = batchPlan.files;
      if (selectedFileList.length === 0 && Object.keys(files).length > 0) {
        logger.warn(`[${requestId}] File selection returned 0 files for a non-empty project — falling back to topic-steps mode`);
        writer.writeData({
          type: "progress",
          label: "plan-file-select-warn",
          status: "complete",
          order: progressCounter.value++,
          message: "Could not identify specific files to change — using holistic analysis mode instead.",
        } satisfies ProgressAnnotation);
      }
    } catch (err: any) {
      logger.warn(`[${requestId}] File selection failed (${err?.message}), falling back to topic-steps mode`);
      selectedFileList = [];
      fileSelectionFailed = true;
      writer.writeData({
        type: "progress",
        label: "plan-file-select-warn",
        status: "complete",
        order: progressCounter.value++,
        message: `File analysis failed (${err?.message ?? "unknown error"}) — falling back to holistic analysis mode.`,
      } satisfies ProgressAnnotation);
    }

    logger.info(`[${requestId}] ► BATCH PLANNER returned ${selectedFileList.length} file(s) (threshold=${FILE_PER_STEP_THRESHOLD}) failed=${fileSelectionFailed}`);
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
  let silentFailedSteps = 0;
  let circuitBroken = false;

  const accumulatedFiles: FileMap = { ...files };
  const originalFiles: FileMap = { ...files };
  const completedStepMemory: CompletedStepMemory[] = [];

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

    if (executionMode !== "files") {
      const validation = await validateStep(step, steps, accumulatedFiles);
      if (!validation.valid) {
        if (validation.fixedStep) {
          logger.info(`${stepTag} [validator] step auto-fixed — applying corrected spec`);
          step = validation.fixedStep;
        } else {
          logger.warn(`${stepTag} [validator] step rejected (unfixable): ${validation.issues.join("; ")}`);
          writer.writeData({
            type: "progress",
            label: `plan-step${step.index}-warn`,
            status: "complete",
            order: progressCounter.value++,
            message: `Step ${step.index} was rejected by validator: ${validation.issues[0] ?? "invalid step"}. Skipping.`,
          } satisfies ProgressAnnotation);
          silentFailedSteps++;
          return;
        }
      }

      const packageJson = extractPackageJson(accumulatedFiles);
      const depResult = injectMissingDependencies(step, packageJson);
      if (depResult.injected) {
        logger.info(`${stepTag} [dep-injector] injected missing deps into step: ${depResult.missingDeps.join(", ")}`);
        step = depResult.enrichedStep;
      }
    }

    const stepMessages =
      executionMode === "files"
        ? buildFileStepMessages(messages, steps, step, userQuestion!, accumulatedFiles)
        : buildTopicStepMessages(messages, steps, step, usePlanMd, planContent, userQuestion ?? null, accumulatedFiles, originalFiles, completedStepMemory);

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

    const runStreamStep = async (activeStep: PlanStep, activeMessages: ReturnType<typeof buildTopicStepMessages>) => {
      return streamStep({
        requestId,
        res,
        stepMessages: activeMessages,
        filesToUse,
        allFiles: accumulatedFiles,
        streamingOptions,
        apiKeys,
        providerSettings,
        chatMode,
        designScheme,
        summary,
        stepIndex: activeStep.index,
        cumulativeUsage,
        clientAbortSignal,
        promptId: isTestRequest ? "plan-test" : "plan",
      });
    };

    try {
      const { stepText, succeeded } = await runStreamStep(step, stepMessages);

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

      let finalStepText = stepText;
      let finalStep = step;

      if (executionMode !== "files") {
        const score = scoreExecution(step, stepText);

        if (!score.passed) {
          logger.warn(`${stepTag} [scorer] score=${score.score}/100 below threshold=${PASS_THRESHOLD} — entering self-heal loop`);

          for (let healAttempt = 1; healAttempt <= SELF_HEAL_MAX_ATTEMPTS; healAttempt++) {
            if (clientAbortSignal?.aborted || !writer.isAlive()) break;

            writer.writeData({
              type: "progress",
              label: `plan-step${step.index}-heal`,
              status: "in-progress",
              order: progressCounter.value++,
              message: `Step ${step.index} quality below threshold (score ${score.score}/100) — self-healing attempt ${healAttempt}/${SELF_HEAL_MAX_ATTEMPTS}`,
            } satisfies ProgressAnnotation);

            const { repairedStep, freshStart } = await repairStep(finalStep, finalStepText, score, healAttempt);
            finalStep = repairedStep;

            if (freshStart) {
              logger.info(`${stepTag} [self-heal] attempt ${healAttempt} is a FRESH START — discarding previous output`);
            }

            const repairedMessages = buildTopicStepMessages(
              messages, steps, finalStep, usePlanMd, planContent, userQuestion ?? null, accumulatedFiles, originalFiles, completedStepMemory,
            );

            const healResult = await runStreamStep(finalStep, repairedMessages);

            if (!healResult.succeeded) {
              logger.warn(`${stepTag} [self-heal] attempt ${healAttempt} stream failed — stopping heal loop`);
              break;
            }

            finalStepText = healResult.stepText;

            const reScore = scoreExecution(finalStep, finalStepText);
            logger.info(`${stepTag} [self-heal] attempt ${healAttempt} re-score=${reScore.score}/100 passed=${reScore.passed}`);

            if (reScore.passed) {
              writer.writeData({
                type: "progress",
                label: `plan-step${step.index}-heal`,
                status: "complete",
                order: progressCounter.value++,
                message: `Step ${step.index} self-healed successfully (score ${reScore.score}/100)`,
              } satisfies ProgressAnnotation);
              break;
            }

            if (healAttempt === SELF_HEAL_MAX_ATTEMPTS) {
              logger.warn(`${stepTag} [self-heal] max attempts reached, proceeding with best available output (score=${reScore.score}/100)`);
              writer.writeData({
                type: "progress",
                label: `plan-step${step.index}-heal`,
                status: "complete",
                order: progressCounter.value++,
                message: `Step ${step.index} self-heal exhausted — proceeding with best output (score ${reScore.score}/100)`,
              } satisfies ProgressAnnotation);
            }
          }
        } else {
          logger.info(`${stepTag} [scorer] score=${score.score}/100 ✓ passed threshold`);
        }
      }

      const generatedFiles = extractGeneratedFiles(finalStepText, accumulatedFiles);
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
        writer.writeData({
          type: "progress",
          label: `plan-step${step.index}-warn`,
          status: "complete",
          order: progressCounter.value++,
          message: `Step ${step.index} produced no file changes — the LLM response contained no file blocks. This step may need to be re-run.`,
        } satisfies ProgressAnnotation);
        silentFailedSteps++;
      }

      if (!writer.isAlive()) {
        logger.warn(`${stepTag} client disconnected after step output, aborting`);
        return;
      }

      completedStepMemory.push({
        index: step.index,
        heading: step.heading,
        filesProduced: Object.keys(generatedFiles),
      });

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

  if (executionMode !== "files") {
    const sanity = runPlanSanityCheck(steps);

    if (sanity.issues.length > 0) {
      const blockers = sanity.issues.filter((i) => i.type === "FORWARD_REF");
      const warnings = sanity.issues.filter((i) => i.type !== "FORWARD_REF");

      if (blockers.length > 0) {
        logger.warn(
          `[${requestId}] [plan-sanity] ${blockers.length} forward-reference issue(s) detected — steps may fail`,
        );
        writer.writeData({
          type: "progress",
          label: "plan-sanity-warn",
          status: "complete",
          order: progressCounter.value++,
          message: `Plan warning: ${blockers.length} step(s) may have forward references. Proceeding but some steps may need repair.`,
        } satisfies ProgressAnnotation);
      }

      if (warnings.length > 0) {
        logger.info(`[${requestId}] [plan-sanity] ${warnings.length} non-blocking issue(s): ${warnings.map((i) => i.message).join("; ")}`);
      }
    }

    if (sanity.symbolConflicts.length > 0) {
      logger.warn(`[${requestId}] [plan-sanity] ${sanity.symbolConflicts.length} potential symbol conflict(s) — injecting consistency warnings`);
      steps = injectSymbolWarningsIntoSteps(steps, sanity.symbolConflicts);
    }
  }

  const sequentialPlan = buildSequentialExecutionPlan(steps);
  logger.info(`[${requestId}] [sequential-executor] executing ${sequentialPlan.totalSteps} step(s) sequentially`);

  for (const step of sequentialPlan.steps) {
    if (!writer.isAlive() || circuitBroken) break;
    await executeStep(step);
  }

  logger.info(
    `[${requestId}] ═══ PLAN COMPLETE ═══ steps=${steps.length} succeeded=${succeededSteps} failed=${failedSteps} silent=${silentFailedSteps} circuitBroken=${circuitBroken} totalTokens=${cumulativeUsage.totalTokens} promptTokens=${cumulativeUsage.promptTokens} completionTokens=${cumulativeUsage.completionTokens}`,
  );

  const originalFilePaths = new Set(Object.keys(files));
  const createdFiles: string[] = [];
  const modifiedFiles: string[] = [];
  for (const filePath of Object.keys(accumulatedFiles)) {
    if (!originalFilePaths.has(filePath)) {
      createdFiles.push(filePath);
    } else {
      const originalEntry = (files as any)[filePath];
      const accEntry = (accumulatedFiles as any)[filePath];
      if (
        originalEntry?.type === "file" &&
        accEntry?.type === "file" &&
        originalEntry?.content !== accEntry?.content
      ) {
        modifiedFiles.push(filePath);
      }
    }
  }

  if (executionMode !== "files" && succeededSteps > 0 && writer.isAlive()) {
    const completeness = checkCompleteness(accumulatedFiles, originalFiles);
    const hasIntegrationIssues =
      completeness.orphanFiles.length > 0 ||
      !completeness.hasEntryPoint ||
      completeness.routingIssues.length > 0 ||
      completeness.serviceIssues.length > 0;

    if (hasIntegrationIssues) {
      logger.warn(`[${requestId}] [completeness] ${completeness.summary}`);
      if (completeness.routingIssues.length > 0) {
        for (const issue of completeness.routingIssues) {
          logger.warn(`[${requestId}] [completeness] ROUTING: ${issue.message}`);
        }
      }
      if (completeness.serviceIssues.length > 0) {
        for (const issue of completeness.serviceIssues) {
          logger.warn(`[${requestId}] [completeness] SERVICE: ${issue.message}`);
        }
      }
      writer.writeData({
        type: "progress",
        label: "plan-completeness-warn",
        status: "complete",
        order: progressCounter.value++,
        message: `Integration check: ${completeness.summary}`,
      } satisfies ProgressAnnotation);
    } else {
      logger.info(`[${requestId}] [completeness] All generated files appear connected and integrated`);
    }
  }

  writer.writeAnnotation({
    type: "planFileSummary",
    createdFiles,
    modifiedFiles,
    succeededSteps,
    failedSteps,
    silentFailedSteps,
    totalSteps: steps.length,
  });

  logger.info(
    `[${requestId}] ► FILE SUMMARY — created=${createdFiles.length} modified=${modifiedFiles.length}`,
  );
  for (const f of createdFiles) logger.info(`[${requestId}]   + ${f}`);
  for (const f of modifiedFiles) logger.info(`[${requestId}]   ~ ${f}`);

  const warnSuffix =
    silentFailedSteps > 0
      ? ` (${silentFailedSteps} step${silentFailedSteps !== 1 ? "s" : ""} produced no file changes)`
      : "";

  writer.writeData({
    type: "progress",
    label: "plan-complete",
    status: "complete",
    order: progressCounter.value++,
    message: `Implementation complete: ${succeededSteps}/${steps.length} step${steps.length !== 1 ? "s" : ""} executed${failedSteps > 0 ? `, ${failedSteps} failed` : ""}${warnSuffix}. ${createdFiles.length} file${createdFiles.length !== 1 ? "s" : ""} created, ${modifiedFiles.length} modified.`,
  } satisfies ProgressAnnotation);
}

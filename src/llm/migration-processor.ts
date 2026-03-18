import { generateText, type CoreTool, type GenerateTextResult } from "ai";
import { Readable } from "node:stream";
import { generateId } from "ai";
import type { Response } from "express";

import { createScopedLogger } from "../utils/logger";
import { getTachyonModel } from "../modules/llm/providers/tachyon";
import { streamText, type Messages, type StreamingOptions } from "./stream-text";
import type { FileMap } from "./constants";
import type { IProviderSetting } from "../types/model";
import type { ProgressAnnotation } from "../types/context";

const logger = createScopedLogger("migration-processor");

export interface MigrationStep {
  index: number;
  heading: string;
  details: string;
}

export interface MigrationStreamWriter {
  writeData: (data: unknown) => boolean;
  writeAnnotation: (annotation: unknown) => boolean;
  isAlive: () => boolean;
}

const MIGRATION_FRAME_RE = /^([0-9a-z]+):(.+)\n?$/;

export async function parseMigrationPlanIntoSteps(
  migrationDocument: string,
  originalFiles: FileMap,
  onFinish?: (resp: GenerateTextResult<Record<string, CoreTool<any, any>>, never>) => void,
): Promise<MigrationStep[]> {
  logger.info("Parsing Migration.md into steps...");

  const originalFileList = Object.keys(originalFiles)
    .filter((k) => (originalFiles[k] as any)?.type === "file")
    .join("\n");

  const resp = await generateText({
    model: getTachyonModel(),
    system: `
You are a world-class Spring migration architect specializing in converting Spring Web MVC (XML-based) applications into Spring Boot (Java config + auto-configuration).

Your job is to read a Migration.md document and break it into an ordered list of implementation steps that an LLM coding agent will execute one by one.

Return ONLY a valid JSON array — no prose, no markdown fences.

Each element must have:
"index"   : number
"heading" : string
"details" : string

---

🚨 CORE RESPONSIBILITY:

You are NOT just splitting steps.

You are instructing an agent to:
👉 READ each original file
👉 UNDERSTAND its behavior
👉 TRANSFORM it into Spring Boot equivalent

---

MIGRATION-SPECIFIC RULES:

- ALL output files must be under migrate/
- DO NOT copy files — TRANSFORM them into Spring Boot style
- EVERY file in Migration.md must appear in exactly one step
- EVERY step must include EXACT implementation details (not summaries)

---

🚨 SPRING-SPECIFIC TRANSFORMATION RULES (MANDATORY):

For EACH file, you MUST explicitly describe:

1. HOW the original file is interpreted
2. HOW it is transformed into Spring Boot

---

### XML FILE HANDLING (CRITICAL):

If a step includes XML files:

You MUST describe transformation like:

- web.xml:
  → Remove it
  → Create migrate/src/main/java/.../Application.java
  → Add @SpringBootApplication
  → Explain embedded Tomcat replacement

- dispatcher-servlet.xml:
  → Convert to @Configuration OR remove if Boot auto-config handles it
  → Explain component scanning / view resolver handling

- applicationContext.xml:
  → Convert each <bean> into:
     - @Component / @Service OR
     - @Bean method inside @Configuration class
  → Show class names and method signatures

- property placeholders:
  → Move to application.properties

---

### JAVA FILE HANDLING:

For each Java file:

- Keep business logic EXACTLY the same
- Update:
  - Imports
  - Annotations (@Controller → @RestController if needed)
  - Dependency injection (XML → @Autowired or constructor injection)

---

### DETAILS FIELD MUST INCLUDE:

- Exact file path under migrate/
- Class names
- Method signatures
- Annotations
- Config keys
- Explicit mapping:
  "Port src/.../X.java → migrate/.../X.java"

---

STEP ORGANIZATION RULES:

- Group related files (max 8 per step)
- Order MUST follow:

1. Build file + Spring Boot main class
2. Configuration (including XML transformations)
3. Models / entities
4. Repository layer
5. Service layer
6. Controllers
7. Properties + static resources

---

FORBIDDEN:

- Generic instructions like "convert config"
- Missing transformation explanation
- Copying XML files directly
- Steps without file-level detail

---

OUTPUT:
Return ONLY a JSON array.
`,
    prompt: `
ORIGINAL PROJECT FILES (for reference — do NOT modify these):
${originalFileList}

MIGRATION DOCUMENT:
<migration>
${migrationDocument}
</migration>

Generate executable migration steps where each step explicitly converts original files into Spring Boot files. Do not summarize — produce transformation instructions. Every file listed in the migration document must appear in exactly one step. All output paths must start with migrate/.
`,
  });

  if (onFinish) onFinish(resp);

  try {
    const cleaned = resp.text.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "");
    const parsed = JSON.parse(cleaned) as MigrationStep[];
    logger.info(`Parsed ${parsed.length} migration steps from Migration.md`);
    return parsed;
  } catch (err: any) {
    logger.error("Failed to parse migration step response as JSON, falling back to single step", err);
    return [{ index: 1, heading: "Implement Migration", details: migrationDocument }];
  }
}

export interface StreamMigrationOptions {
  res: Response;
  requestId: string;
  messages: Messages;
  files: FileMap;
  migrationDocument: string;
  steps: MigrationStep[];
  streamingOptions: StreamingOptions;
  apiKeys: Record<string, string>;
  providerSettings: Record<string, IProviderSetting>;
  progressCounter: { value: number };
  writer: MigrationStreamWriter;
  cumulativeUsage: {
    completionTokens: number;
    promptTokens: number;
    totalTokens: number;
  };
  clientAbortSignal?: AbortSignal;
}

const MAX_STEP_RETRIES = 2;
const STEP_RETRY_BASE_DELAY_MS = 1_000;
const CIRCUIT_BREAKER_MIN_ATTEMPTS = 5;
const CIRCUIT_BREAKER_FAILURE_RATE = 0.7;

export async function streamMigrationResponse(opts: StreamMigrationOptions): Promise<void> {
  const {
    res,
    requestId,
    messages,
    files,
    migrationDocument,
    steps,
    streamingOptions,
    apiKeys,
    providerSettings,
    progressCounter,
    writer,
    cumulativeUsage,
    clientAbortSignal,
  } = opts;

  logger.info(
    `[${requestId}] ═══ streamMigrationResponse START ═══ steps=${steps.length} projectFiles=${Object.keys(files).length}`,
  );

  writer.writeData({
    type: "progress",
    label: "migration-parse",
    status: "complete",
    order: progressCounter.value++,
    message: `Migration plan ready: ${steps.length} implementation step${steps.length !== 1 ? "s" : ""}`,
  } satisfies ProgressAnnotation);

  writer.writeAnnotation({
    type: "planSteps",
    steps: steps.map((s) => ({ index: s.index, heading: s.heading })),
    totalSteps: steps.length,
    executionMode: "steps",
  });

  const sharedMessageId = generateId();
  res.write(`f:${JSON.stringify({ messageId: sharedMessageId })}\n`);
  logger.info(`[${requestId}] Emitted shared messageId: ${sharedMessageId}`);

  let succeededSteps = 0;
  let failedSteps = 0;
  let circuitBroken = false;

  const accumulatedFiles: FileMap = { ...files };

  for (const step of steps) {
    if (!writer.isAlive() || circuitBroken) break;
    if (clientAbortSignal?.aborted) break;

    const stepTag = `[${requestId}][step ${step.index}/${steps.length}]`;
    logger.info(`${stepTag} ─── START ─── "${step.heading}"`);

    writer.writeData({
      type: "progress",
      label: `migration-step${step.index}`,
      status: "in-progress",
      order: progressCounter.value++,
      message: `Step ${step.index}/${steps.length}: ${step.heading}`,
    } satisfies ProgressAnnotation);

    const stepMessages = buildMigrationStepMessages(
      messages,
      steps,
      step,
      migrationDocument,
      accumulatedFiles,
    );

    try {
      const { stepText, succeeded } = await executeMigrationStep({
        requestId,
        res,
        stepMessages,
        files: accumulatedFiles,
        streamingOptions,
        apiKeys,
        providerSettings,
        stepIndex: step.index,
        cumulativeUsage,
        clientAbortSignal,
      });

      if (!succeeded) {
        logger.warn(`${stepTag} ✗ FAILED (all retries exhausted)`);
        failedSteps++;
        writer.writeData({
          type: "progress",
          label: "migration-step-error",
          status: "complete",
          order: progressCounter.value++,
          message: `Step ${step.index} failed after all retries. Continuing...`,
        } satisfies ProgressAnnotation);
        continue;
      }

      const generatedFiles = extractMigrationFiles(stepText);
      const generatedCount = Object.keys(generatedFiles).length;
      if (generatedCount > 0) {
        Object.assign(accumulatedFiles, generatedFiles);
        logger.info(`${stepTag} ► ${generatedCount} file(s) generated`);
        for (const fp of Object.keys(generatedFiles)) {
          logger.info(`${stepTag}   ↳ ${fp}`);
        }
      } else {
        logger.warn(`${stepTag} ► 0 files extracted from response`);
      }

      succeededSteps++;

      writer.writeData({
        type: "progress",
        label: `migration-step${step.index}`,
        status: "complete",
        order: progressCounter.value++,
        message: `Step ${step.index}/${steps.length} done: ${step.heading}`,
      } satisfies ProgressAnnotation);

      logger.info(`${stepTag} ─── DONE ─── succeeded=${succeededSteps} failed=${failedSteps}`);
    } catch (err: any) {
      logger.error(`${stepTag} ✗ ERROR: ${err?.message}`, err);

      writer.writeData({
        type: "progress",
        label: "migration-step-error",
        status: "complete",
        order: progressCounter.value++,
        message: `Step ${step.index} failed: ${err?.message || "Unknown error"}. Continuing...`,
      } satisfies ProgressAnnotation);

      failedSteps++;

      const totalAttempted = succeededSteps + failedSteps;
      if (totalAttempted >= CIRCUIT_BREAKER_MIN_ATTEMPTS) {
        const failureRate = failedSteps / totalAttempted;
        if (failureRate >= CIRCUIT_BREAKER_FAILURE_RATE) {
          logger.error(
            `[${requestId}] Circuit breaker triggered: ${failedSteps}/${totalAttempted} steps failed. Aborting migration.`,
          );
          writer.writeData({
            type: "progress",
            label: "migration-error",
            status: "complete",
            order: progressCounter.value++,
            message: `Migration aborted: ${failedSteps} of ${totalAttempted} steps failed. Please try again.`,
          } satisfies ProgressAnnotation);
          circuitBroken = true;
        }
      }
    }
  }

  logger.info(
    `[${requestId}] ═══ MIGRATION COMPLETE ═══ steps=${steps.length} succeeded=${succeededSteps} failed=${failedSteps} circuitBroken=${circuitBroken}`,
  );

  writer.writeData({
    type: "progress",
    label: "migration-complete",
    status: "complete",
    order: progressCounter.value++,
    message: `Migration complete: ${succeededSteps}/${steps.length} step${steps.length !== 1 ? "s" : ""} executed${failedSteps > 0 ? `, ${failedSteps} failed` : ""}`,
  } satisfies ProgressAnnotation);
}

function buildMigrationStepMessages(
  messages: Messages,
  steps: MigrationStep[],
  step: MigrationStep,
  migrationDocument: string,
  accumulatedFiles: FileMap,
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

  const alreadyCreatedFiles = Object.keys(accumulatedFiles)
    .filter((p) => p.includes("/migrate/") || p.startsWith("migrate/"))
    .map((p) => `  - ${p}`)
    .join("\n");

  const existingFileContext = buildMigrationFileContext(step, accumulatedFiles);

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
        `## Migration Progress`,
        allStepsList,
        ``,
        alreadyCreatedFiles ? `## Already created in migrate/:\n${alreadyCreatedFiles}` : "",
        ``,
        `## Your Task - Step ${step.index}/${steps.length}: ${step.heading}`,
        ``,
        step.details,
        existingFileContext,
        ``,
        remainingSteps
          ? `## Do NOT implement yet (upcoming steps):\n${remainingSteps}`
          : `## This is the FINAL step — complete the migration.`,
        ``,
        MIGRATION_STEP_INSTRUCTIONS,
      ].filter(Boolean).join("\n"),
    } as any);
  } else {
    stepMessages.push({
      id: generateId(),
      role: "user",
      content: [
        `You are implementing a project migration step by step. There are ${steps.length} steps in total.`,
        `All migrated files must be created under the \`migrate/\` folder.`,
        `DO NOT modify any original source files — only create new files under migrate/.`,
        ``,
        `## Migration Document (for reference)`,
        migrationDocument,
        ``,
        `## Full Step Overview`,
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
          : `## This is the ONLY step — complete the full migration.`,
        ``,
        MIGRATION_STEP_INSTRUCTIONS,
      ].filter(Boolean).join("\n"),
    } as any);
  }

  return stepMessages;
}

function buildMigrationFileContext(step: MigrationStep, files: FileMap): string {
  const searchText = step.heading + " " + step.details;

  const referencedMigratePaths: string[] = [];
  const referencedSourcePaths: string[] = [];

  for (const filePath of Object.keys(files)) {
    const isMigratePath = filePath.includes("/migrate/") || filePath.startsWith("migrate/");
    const basename = filePath.split("/").pop() ?? "";
    const relativePath = filePath.replace("/home/project/", "");

    const isReferenced =
      searchText.includes(filePath) ||
      searchText.includes(relativePath) ||
      searchText.includes(basename);

    if (!isReferenced) continue;

    if (isMigratePath) {
      referencedMigratePaths.push(filePath);
    } else {
      referencedSourcePaths.push(filePath);
    }
  }

  const sections: string[] = [];

  if (referencedSourcePaths.length > 0) {
    sections.push(`\n## Original source files to port (use these as the source of truth for business logic):`);
    for (const filePath of referencedSourcePaths) {
      const entry = files[filePath] as any;
      if (!entry || entry.type !== "file" || entry.isBinary) continue;
      sections.push(`\n### ${filePath}\n\`\`\`\n${entry.content}\n\`\`\``);
    }
  }

  if (referencedMigratePaths.length > 0) {
    sections.push(`\n## Already-created migrate/ files referenced in this step (DO NOT recreate — only extend if needed):`);
    for (const filePath of referencedMigratePaths) {
      const entry = files[filePath] as any;
      if (!entry || entry.type !== "file" || entry.isBinary) continue;
      sections.push(`\n### ${filePath}\n\`\`\`\n${entry.content}\n\`\`\``);
    }
  }

  return sections.length > 0 ? sections.join("\n") : "";
}

const MIGRATION_STEP_INSTRUCTIONS = `## Migration Execution Rules

You are performing a REAL framework migration from Spring Web MVC (XML-based) to Spring Boot.

CORE RULE:
You MUST follow this flow for EVERY file:
1. READ the original file content (provided above)
2. UNDERSTAND its behavior and purpose
3. TRANSFORM it into Spring Boot equivalent
4. CREATE the new file under migrate/

---

## TRANSFORMATION REQUIREMENTS

DO NOT copy code blindly
DO NOT recreate XML
ALWAYS convert to Spring Boot style

---

## XML -> SPRING BOOT (MANDATORY)

When handling XML files:

### web.xml
- DO NOT recreate this file
- Create: migrate/src/main/java/.../Application.java
- Add: @SpringBootApplication and public static void main(String[] args)
- DispatcherServlet is auto-configured; embedded Tomcat replaces servlet container

### dispatcher-servlet.xml
- DO NOT copy XML
- Convert to @Configuration class OR remove if Spring Boot auto-config handles it
- Component scan -> @SpringBootApplication
- View resolver -> application.properties or config class

### applicationContext.xml
For EACH <bean>:
- If it's a service/dao: Convert to @Service / @Repository
- If it's infrastructure: Create @Configuration class with @Bean methods

### properties / placeholders
- Move ALL values to: migrate/src/main/resources/application.properties

---

## JAVA FILE TRANSFORMATION

For EACH Java file:
- Port ALL business logic EXACTLY
- Update imports and annotations (@Controller -> @RestController if needed)
- Update dependency injection (XML wiring -> @Autowired or constructor injection)
- Controllers: ensure @RestController or @Controller with proper @RequestMapping

---

## OUTPUT RULES

- ALL files MUST be created under migrate/
- Use FULL paths like: migrate/src/main/java/com/example/service/UserService.java
- Each file must be complete, compilable, and production-ready

---

## CONTEXT AWARENESS

- Use "Original source files to port" as the source of truth
- If a file already exists in migrate/, EXTEND it — do NOT recreate

---

## FORBIDDEN

- Creating empty files
- Skipping business logic
- Copying XML directly
- Writing pseudo-code or TODOs

---

## OUTPUT FORMAT

ONLY output file changes using:

<cortexAction type="file" filePath="migrate/...">
...FULL FILE CONTENT...
</cortexAction>

No explanations. No markdown.`;

async function executeMigrationStep(opts: {
  requestId: string;
  res: Response;
  stepMessages: Messages;
  files: FileMap;
  streamingOptions: StreamingOptions;
  apiKeys: Record<string, string>;
  providerSettings: Record<string, IProviderSetting>;
  stepIndex: number;
  cumulativeUsage: { completionTokens: number; promptTokens: number; totalTokens: number };
  clientAbortSignal?: AbortSignal;
}): Promise<{ stepText: string; succeeded: boolean }> {
  const { requestId, res, stepMessages, files, stepIndex, cumulativeUsage } = opts;

  for (let attempt = 0; attempt <= MAX_STEP_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = STEP_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      logger.info(`[${requestId}] Migration step ${stepIndex} retry ${attempt}/${MAX_STEP_RETRIES}, backoff=${delay}ms`);
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
        files,
        providerSettings: opts.providerSettings,
        promptId: "migration",
        chatMode: "build",
        contextOptimization: false,
        contextFiles: files,
        messageSliceId: undefined,
        clientAbortSignal: opts.clientAbortSignal,
      });

      const response = result.toDataStreamResponse();

      const [stepText] = await Promise.all([
        result.text,
        response.body
          ? pipeMigrationStream(requestId, res, response.body, stepIndex)
          : Promise.resolve(),
      ]);

      const usage = await result.usage;
      if (usage) {
        cumulativeUsage.completionTokens += usage.completionTokens || 0;
        cumulativeUsage.promptTokens += usage.promptTokens || 0;
        cumulativeUsage.totalTokens += usage.totalTokens || 0;
      }

      logger.info(
        `[${requestId}] Migration step ${stepIndex} finished: tokens=${usage?.totalTokens || 0}`,
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
        logger.error(`[${requestId}] Migration step ${stepIndex} failed (attempt ${attempt + 1}): ${err?.message}`);
        if (!isRetryable) throw err;
        break;
      }

      logger.warn(`[${requestId}] Migration step ${stepIndex} attempt ${attempt + 1} failed (retryable): ${err?.message}`);
    }
  }

  return { stepText: "", succeeded: false };
}

async function pipeMigrationStream(
  requestId: string,
  res: Response,
  webStream: ReadableStream,
  stepNum: number,
): Promise<void> {
  if (res.writableEnded || res.destroyed) {
    logger.warn(`[${requestId}] Response already ended before piping migration step ${stepNum}`);
    return;
  }

  const nodeStream = Readable.fromWeb(webStream as any);
  let lineBuffer = "";

  function processLine(line: string): void {
    if (!line) return;
    const m = MIGRATION_FRAME_RE.exec(line);
    if (m) {
      const prefix = m[1];
      if (prefix === "f" || prefix === "e" || prefix === "d" || prefix === "g") return;
      if (prefix === "3") {
        logger.warn(`[${requestId}] Migration step ${stepNum} LLM error frame: ${m[2]}`);
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
      logger.error(`[${requestId}] Migration step ${stepNum} stream error: ${err?.message}`, err);
      reject(err);
    });
  });
}

function sanitizeMigrationPath(rawPath: string): string | null {
  const normalized = rawPath.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (normalized.includes("..") || normalized.includes("\0")) return null;

  if (normalized.startsWith("/home/project/migrate/")) return normalized;
  if (normalized.startsWith("migrate/")) return `/home/project/${normalized}`;

  return null;
}

function extractMigrationFiles(stepText: string): FileMap {
  const updated: FileMap = {};
  const fileBlockRe = /<cortexAction[^>]*type="file"[^>]*filePath="([^"]+)"[^>]*>([\s\S]*?)<\/cortexAction>/g;
  let match: RegExpExecArray | null;

  while ((match = fileBlockRe.exec(stepText)) !== null) {
    const rawPath = match[1];
    const content = match[2];
    const fullPath = sanitizeMigrationPath(rawPath);

    if (!fullPath) {
      logger.warn(`extractMigrationFiles: skipping non-migrate/ path "${rawPath}"`);
      continue;
    }

    updated[fullPath] = { type: "file", content, isBinary: false } as any;
  }

  return updated;
}

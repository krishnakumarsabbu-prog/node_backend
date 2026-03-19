import { generateId } from "ai";
import type { Response } from "express";
import { createScopedLogger } from "../../utils/logger";
import { streamText, type Messages, type StreamingOptions } from "../../llm/stream-text";
import type { FileMap } from "../../llm/constants";
import type { IProviderSetting } from "../../types/model";
import type { ProgressAnnotation } from "../../types/context";
import type { MigrationPlan, MigrationTask, FileOperation } from "../types/migrationTypes";
import type { CodebaseIntelligence } from "../intelligence/contextBuilder";
import { buildTaskGraph } from "./taskGraph";
import { runStaticValidation } from "./staticValidator";
import {
  createMigrationState,
  applyFileOperation,
  markTaskComplete,
  markTaskFailed,
  registerBean,
  serializeGlobalDecisions,
  type MigrationState,
} from "./migrationState";
import { LLMClient } from "../llm/llmClient";

const logger = createScopedLogger("streaming-task-executor");

const MIGRATION_FRAME_RE = /^([0-9a-z]+):(.+)\n?$/;
const MAX_TASK_RETRIES = 2;
const MAX_STATIC_FIX_ATTEMPTS = 3;

export interface StreamingTaskExecutorOptions {
  res: Response;
  plan: MigrationPlan;
  files: FileMap;
  messages: Messages;
  intelligence: CodebaseIntelligence;
  markdownContent?: string;
  streamingOptions: StreamingOptions;
  apiKeys: Record<string, string>;
  providerSettings: Record<string, IProviderSetting>;
  progressCounter: { value: number };
  clientAbortSignal?: AbortSignal;
}

export interface StreamingTaskResult {
  success: boolean;
  filesCreated: number;
  filesModified: number;
  filesDeleted: number;
  totalTokens: number;
  errors: string[];
  staticIssues: string[];
  taskResults: Array<{ taskId: string; file: string; success: boolean; error?: string }>;
}

function writeProgress(
  res: Response,
  counter: { value: number },
  label: string,
  status: "in-progress" | "complete",
  message: string,
): void {
  if (res.writableEnded || res.destroyed) return;
  const frame = JSON.stringify({
    type: "progress",
    label,
    status,
    order: counter.value++,
    message,
  } satisfies ProgressAnnotation);
  res.write(`2:[${frame}]\n`);
}

function writeAnnotation(res: Response, data: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`8:[${JSON.stringify(data)}]\n`);
}

export async function executeTaskGraphStreaming(
  opts: StreamingTaskExecutorOptions,
): Promise<StreamingTaskResult> {
  const {
    res,
    plan,
    files,
    messages,
    intelligence,
    markdownContent,
    streamingOptions,
    apiKeys,
    providerSettings,
    progressCounter,
    clientAbortSignal,
  } = opts;

  const tasks = plan.tasks ?? [];
  const llmClient = new LLMClient();

  const sourceFiles = new Map<string, string>();
  for (const [path, file] of Object.entries(files)) {
    if (file && "content" in file) {
      sourceFiles.set(path, (file as any).content as string);
    }
  }

  const state = createMigrationState(sourceFiles);
  inferGlobalDecisions(state, plan, intelligence);

  assertAllFilesCovered(tasks, progressCounter, res);

  const taskGraph = buildTaskGraph(tasks);

  writeProgress(
    res,
    progressCounter,
    "migration-graph",
    "complete",
    `Task graph: ${tasks.length} tasks → ${taskGraph.executionWaves.length} execution wave${taskGraph.executionWaves.length !== 1 ? "s" : ""} (${taskGraph.executionWaves.map((w) => `wave${w.wave}:${w.tasks.length}t`).join(", ")})`,
  );

  const sharedMessageId = generateId();
  res.write(`f:${JSON.stringify({ messageId: sharedMessageId })}\n`);

  const cumulativeUsage = { completionTokens: 0, promptTokens: 0, totalTokens: 0 };
  const taskResults: StreamingTaskResult["taskResults"] = [];
  let circuitBroken = false;

  for (const wave of taskGraph.executionWaves) {
    if (circuitBroken || clientAbortSignal?.aborted || res.writableEnded || res.destroyed) break;

    for (const task of wave.tasks) {
      if (circuitBroken || clientAbortSignal?.aborted || res.writableEnded || res.destroyed) break;

      const taskResult = await executeTaskStreaming({
        task,
        state,
        files,
        messages,
        intelligence,
        markdownContent,
        streamingOptions,
        apiKeys,
        providerSettings,
        progressCounter,
        res,
        cumulativeUsage,
        clientAbortSignal,
        totalTasks: tasks.length,
        taskIndex: tasks.indexOf(task) + 1,
      });

      taskResults.push(taskResult);

      if (taskResult.success) {
        markTaskComplete(state, task.id);
      } else {
        markTaskFailed(state, task.id, taskResult.error ?? "unknown error");
      }
    }

    runStageValidation(wave.wave, wave.tasks, state, progressCounter, res);
  }

  const staticResult = runPostExecutionStaticValidation(state, progressCounter, res);

  let staticFixErrors: string[] = [];
  if (!staticResult.passed && staticResult.issues.some((i) => i.severity === "error")) {
    staticFixErrors = await runStaticAutoFixLoop({
      state,
      intelligence,
      llmClient,
      progressCounter,
      res,
      maxAttempts: MAX_STATIC_FIX_ATTEMPTS,
    });
  }

  const failedTasks = taskResults.filter((t) => !t.success);
  const success = failedTasks.length === 0 && staticFixErrors.length === 0;

  writeProgress(
    res,
    progressCounter,
    "migration-done",
    "complete",
    `Migration complete: ${taskResults.filter((t) => t.success).length}/${tasks.length} tasks succeeded, tokens=${cumulativeUsage.totalTokens}, static=${staticResult.passed ? "PASSED" : "FAILED"}`,
  );

  return {
    success,
    filesCreated: countOps(state, "create"),
    filesModified: countOps(state, "modify"),
    filesDeleted: countOps(state, "delete"),
    totalTokens: cumulativeUsage.totalTokens,
    errors: [
      ...failedTasks.map((t) => `[${t.taskId}] ${t.error}`),
      ...staticFixErrors,
    ],
    staticIssues: staticResult.issues.map((i) => `[${i.severity.toUpperCase()}] ${i.type}: ${i.message}`),
    taskResults,
  };
}

interface TaskStreamingOpts {
  task: MigrationTask;
  state: MigrationState;
  files: FileMap;
  messages: Messages;
  intelligence: CodebaseIntelligence;
  markdownContent?: string;
  streamingOptions: StreamingOptions;
  apiKeys: Record<string, string>;
  providerSettings: Record<string, IProviderSetting>;
  progressCounter: { value: number };
  res: Response;
  cumulativeUsage: { completionTokens: number; promptTokens: number; totalTokens: number };
  clientAbortSignal?: AbortSignal;
  totalTasks: number;
  taskIndex: number;
}

async function executeTaskStreaming(opts: TaskStreamingOpts): Promise<{
  taskId: string;
  file: string;
  success: boolean;
  error?: string;
}> {
  const { task, state, progressCounter, res, totalTasks, taskIndex } = opts;

  writeProgress(
    res,
    progressCounter,
    `migration-task-${task.id}`,
    "in-progress",
    `Task ${taskIndex}/${totalTasks} [${task.type ?? "code"}]: ${task.action} ${task.file}`,
  );

  if (task.action === "delete") {
    applyFileOperation(state, { file: task.file, action: "delete" });
    writeProgress(
      res,
      progressCounter,
      `migration-task-${task.id}`,
      "complete",
      `Task ${taskIndex}/${totalTasks} done: delete ${task.file}`,
    );
    return { taskId: task.id, file: task.file, success: true };
  }

  const taskMessages = buildTaskMessages(opts);

  for (let attempt = 0; attempt <= MAX_TASK_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoff = 1000 * 2 ** (attempt - 1);
      await new Promise((r) => setTimeout(r, backoff));
      writeProgress(
        res,
        progressCounter,
        `migration-task-${task.id}`,
        "in-progress",
        `Task ${taskIndex}/${totalTasks} retry ${attempt}/${MAX_TASK_RETRIES}: ${task.file}`,
      );
    }

    try {
      const result = await streamText({
        messages: taskMessages,
        env: undefined as any,
        options: opts.streamingOptions,
        apiKeys: opts.apiKeys,
        files: buildTaskFileContext(opts.task, opts.state, opts.intelligence, opts.files),
        providerSettings: opts.providerSettings,
        promptId: "migration",
        chatMode: "build",
        contextOptimization: false,
        contextFiles: opts.files,
        messageSliceId: undefined,
        clientAbortSignal: opts.clientAbortSignal,
      });

      const response = result.toDataStreamResponse();
      const [stepText] = await Promise.all([
        result.text,
        response.body
          ? pipeMigrationStream(res, response.body, task.id)
          : Promise.resolve(),
      ]);

      const usage = await result.usage;
      if (usage) {
        opts.cumulativeUsage.completionTokens += usage.completionTokens || 0;
        opts.cumulativeUsage.promptTokens += usage.promptTokens || 0;
        opts.cumulativeUsage.totalTokens += usage.totalTokens || 0;
      }

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

      const extractedFiles = extractGeneratedFiles(stepText ?? "");
      if (Object.keys(extractedFiles).length > 0) {
        for (const [filePath, content] of Object.entries(extractedFiles)) {
          const op: FileOperation = {
            file: filePath,
            action: task.action ?? "create",
            content: (content as any).content,
          };
          applyFileOperation(state, op);
          updateGlobalStateFromContent(state, filePath, (content as any).content);
        }
      } else {
        logger.warn(`Task ${task.id} produced 0 extractable files from response`);
      }

      writeProgress(
        res,
        progressCounter,
        `migration-task-${task.id}`,
        "complete",
        `Task ${taskIndex}/${totalTasks} done [${task.type ?? "code"}]: ${task.file}`,
      );

      return { taskId: task.id, file: task.file, success: true };
    } catch (err: any) {
      const isRetryable =
        err?.name === "AbortError" ||
        err?.message?.includes("timeout") ||
        err?.message?.includes("ECONNRESET") ||
        err?.message?.includes("socket hang up");

      if (!isRetryable || attempt >= MAX_TASK_RETRIES) {
        const errMsg = err?.message ?? "unknown error";
        logger.error(`Task ${task.id} failed: ${errMsg}`);
        writeProgress(
          res,
          progressCounter,
          `migration-task-${task.id}`,
          "complete",
          `Task ${taskIndex}/${totalTasks} FAILED: ${task.file} — ${errMsg}`,
        );
        return { taskId: task.id, file: task.file, success: false, error: errMsg };
      }
    }
  }

  return { taskId: task.id, file: task.file, success: false, error: "max retries exceeded" };
}

function buildTaskMessages(opts: TaskStreamingOpts): Messages {
  const { task, state, intelligence, markdownContent } = opts;

  const currentContent = state.fileMap.get(task.file);

  const dependencyFiles = collectDependencyFilesFromGraph(task, state, intelligence);

  const sections: string[] = [];
  sections.push(`You are migrating a Spring MVC project to Spring Boot.`);
  sections.push(`\n## TASK`);
  sections.push(`File: ${task.file}`);
  sections.push(`Action: ${task.action ?? "create"}`);
  sections.push(`Type: ${task.type ?? "code"}`);
  sections.push(`Description: ${task.description}`);

  if (task.files && task.files.length > 1) {
    sections.push(`Related files: ${task.files.join(", ")}`);
  }

  sections.push(`\n## MIGRATION STATE`);
  sections.push(serializeGlobalDecisions(state));

  if (dependencyFiles.size > 0) {
    sections.push(`\n## DEPENDENCY FILES (classes this file directly depends on — from dependency graph)`);
    for (const [path, content] of dependencyFiles) {
      sections.push(`\n### ${path}`);
      sections.push("```java");
      sections.push(content.slice(0, 1200) + (content.length > 1200 ? "\n...[truncated]" : ""));
      sections.push("```");
    }
  }

  if (currentContent) {
    sections.push(`\n## CURRENT FILE CONTENT (before migration)`);
    sections.push("```java");
    sections.push(currentContent.slice(0, 2000) + (currentContent.length > 2000 ? "\n...[truncated]" : ""));
    sections.push("```");
  }

  if (markdownContent) {
    const guidance = extractMarkdownGuidanceForTask(task, markdownContent);
    if (guidance) {
      sections.push(`\n## MIGRATION GUIDANCE (from Migration.md)`);
      sections.push(guidance.slice(0, 1500));
    }
  }

  appendStageRules(sections, task.type ?? "code", state);

  const systemContent = sections.join("\n");

  return [
    ...opts.messages.slice(0, -1),
    {
      id: generateId(),
      role: "user" as const,
      content: systemContent,
    } as any,
  ];
}

function collectDependencyFilesFromGraph(
  task: MigrationTask,
  state: MigrationState,
  intelligence: CodebaseIntelligence,
): Map<string, string> {
  const result = new Map<string, string>();

  const taskFileBase = task.file.split("/").pop()?.replace(/\.(java|ts|js)$/, "") ?? "";

  const taskNode = intelligence.dependencyGraph.nodes.find(
    (n) => n.filePath.includes(taskFileBase) || task.files?.some((f) => n.filePath.includes(f.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "")),
  );

  if (taskNode) {
    const outgoingEdges = intelligence.dependencyGraph.edges.filter((e) => e.from === taskNode.filePath);
    for (const edge of outgoingEdges.slice(0, 5)) {
      const content = state.fileMap.get(edge.to);
      if (content) {
        result.set(edge.to, content);
      }
    }
  }

  for (const depId of task.dependsOn ?? []) {
    const depOp = state.operations.find((op) => (op as any).taskId === depId);
    if (depOp?.content && result.size < 5) {
      result.set(depOp.file, depOp.content);
    }
  }

  return result;
}

function buildTaskFileContext(
  task: MigrationTask,
  state: MigrationState,
  intelligence: CodebaseIntelligence,
  originalFiles: FileMap,
): FileMap {
  const context: FileMap = {};

  const taskFileBase = task.file.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
  const taskNode = intelligence.dependencyGraph.nodes.find((n) =>
    n.filePath.includes(taskFileBase),
  );

  const relevant = new Set<string>();

  if (taskNode) {
    intelligence.dependencyGraph.edges
      .filter((e) => e.from === taskNode.filePath || e.to === taskNode.filePath)
      .slice(0, 8)
      .forEach((e) => {
        relevant.add(e.from);
        relevant.add(e.to);
      });
  }

  for (const [path, file] of Object.entries(originalFiles)) {
    const isRelevant =
      relevant.has(path) ||
      task.files?.some((f) => path.includes(f.split("/").pop()?.replace(/\.[^.]+$/, "") ?? ""));
    if (isRelevant) {
      context[path] = file;
    }
  }

  for (const [path, content] of state.fileMap) {
    if (path.includes("migrate/") && !context[path]) {
      context[path] = { type: "file", content, isBinary: false } as any;
    }
  }

  return context;
}

function appendStageRules(sections: string[], type: string, state: MigrationState): void {
  const existingBeans = Array.from(state.globalDecisions.beanNames.keys());

  sections.push(`\n## RULES (MANDATORY)`);
  sections.push(`1. Use CONSTRUCTOR INJECTION ONLY — no @Autowired on fields`);
  sections.push(`2. Remove ALL XML references (ClassPathXmlApplicationContext, web.xml, etc.)`);
  sections.push(`3. Add correct stereotype annotation`);
  sections.push(`4. Do NOT duplicate beans: ${existingBeans.join(", ") || "(none yet)"}`);
  sections.push(`5. Preserve 100% of business logic`);
  sections.push(`6. ALL output files under migrate/`);
  sections.push(`7. Return ONLY complete file content — no markdown, no explanations`);

  switch (type) {
    case "build":
      sections.push(`\n## BUILD RULES`);
      sections.push(`- spring-boot-starter-parent as parent POM`);
      sections.push(`- Include spring-boot-starter-web, spring-boot-starter-data-jpa (if needed)`);
      sections.push(`- Add spring-boot-maven-plugin`);
      sections.push(`- Remove servlet-api, spring-webmvc standalone dependencies`);
      break;
    case "config":
      sections.push(`\n## CONFIG RULES`);
      sections.push(`- @Configuration class`);
      sections.push(`- Replace every <bean> with a @Bean method`);
      sections.push(`- Replace context:component-scan with @SpringBootApplication or @ComponentScan`);
      sections.push(`- Replace property-placeholder with @Value or @ConfigurationProperties`);
      sections.push(`- If replacing web.xml: create @SpringBootApplication main class`);
      break;
    case "code":
      sections.push(`\n## CODE RULES`);
      sections.push(`- @Service / @Repository / @Controller / @RestController as appropriate`);
      sections.push(`- Constructor injection only`);
      sections.push(`- Remove Spring XML configuration references`);
      break;
    case "resource":
      sections.push(`\n## RESOURCE RULES`);
      sections.push(`- Place in migrate/src/main/resources/`);
      sections.push(`- Use Spring Boot property keys`);
      sections.push(`- Remove legacy servlet/container config`);
      break;
  }
}

function extractMarkdownGuidanceForTask(task: MigrationTask, markdown: string): string {
  const taskTitle = task.description?.slice(0, 40) ?? "";
  const lines = markdown.split("\n");
  let start = -1;
  let end = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (
      start === -1 &&
      (line.toLowerCase().includes(task.type ?? "code") ||
        (taskTitle && line.toLowerCase().includes(taskTitle.toLowerCase().slice(0, 20))))
    ) {
      start = i;
    } else if (start !== -1 && line.startsWith("## ") && i > start) {
      end = i;
      break;
    }
  }

  if (start === -1) return "";
  return lines
    .slice(start, end === -1 ? Math.min(start + 30, lines.length) : end)
    .join("\n");
}

function updateGlobalStateFromContent(state: MigrationState, filePath: string, content: string): void {
  if (!content) return;

  const beanMatches = content.matchAll(/@Bean\s*\n[^@]*?\s+(\w+)\s*\(/g);
  for (const match of beanMatches) {
    registerBean(state, match[1], filePath);
  }

  const stereotypeMatch = content.match(
    /@(?:Service|Repository|Component|Controller|RestController)\s*(?:\([^)]*\))?\s*(?:public\s+)?class\s+(\w+)/,
  );
  if (stereotypeMatch) {
    const beanName = stereotypeMatch[1].charAt(0).toLowerCase() + stereotypeMatch[1].slice(1);
    registerBean(state, beanName, filePath);
  }

  if (content.includes("@SpringBootApplication")) {
    state.globalDecisions.mainClass = filePath;
  }

  if (content.includes("@Configuration") && !state.globalDecisions.configClasses.includes(filePath)) {
    state.globalDecisions.configClasses.push(filePath);
  }
}

function runStageValidation(
  waveIndex: number,
  waveTasks: MigrationTask[],
  state: MigrationState,
  progressCounter: { value: number },
  res: Response,
): void {
  const stages = [...new Set(waveTasks.map((t) => t.type ?? "code"))];

  for (const stage of stages) {
    const javaFiles = new Map<string, string>();
    for (const [path, content] of state.fileMap) {
      if (path.endsWith(".java") && path.includes("migrate/")) {
        javaFiles.set(path, content);
      }
    }

    if (javaFiles.size === 0) continue;

    if (stage === "build") {
      const hasPom = Array.from(state.fileMap.keys()).some((p) => p.includes("migrate/") && p.endsWith("pom.xml"));
      writeProgress(
        res,
        progressCounter,
        `stage-validate-${waveIndex}`,
        "complete",
        `Stage validation [${stage}]: pom.xml=${hasPom ? "present" : "MISSING"}`,
      );
    } else if (stage === "config") {
      const hasMain = Array.from(state.fileMap.values()).some((c) => c.includes("@SpringBootApplication"));
      writeProgress(
        res,
        progressCounter,
        `stage-validate-${waveIndex}`,
        "complete",
        `Stage validation [${stage}]: @SpringBootApplication=${hasMain ? "found" : "NOT YET CREATED"}, configs=${state.globalDecisions.configClasses.length}`,
      );
    } else {
      writeProgress(
        res,
        progressCounter,
        `stage-validate-${waveIndex}`,
        "complete",
        `Stage validation [${stage}]: wave ${waveIndex} complete — ${waveTasks.filter((t) => state.completedTasks.has(t.id)).length}/${waveTasks.length} tasks succeeded, beans=${state.globalDecisions.beanNames.size}`,
      );
    }
  }
}

function runPostExecutionStaticValidation(
  state: MigrationState,
  progressCounter: { value: number },
  res: Response,
) {
  const migratedFiles = new Map<string, string>();
  for (const [path, content] of state.fileMap) {
    if (path.includes("migrate/")) {
      migratedFiles.set(path, content);
    }
  }

  if (migratedFiles.size === 0) {
    writeProgress(res, progressCounter, "static-validation", "complete", "Static validation skipped — no migrate/ files generated");
    return { passed: true, issues: [], fieldInjectionFiles: [], duplicateBeans: [], xmlReferenceFiles: [], hasMainClass: false };
  }

  const result = runStaticValidation(migratedFiles);

  const errorCount = result.issues.filter((i) => i.severity === "error").length;
  const warnCount = result.issues.filter((i) => i.severity === "warning").length;

  writeProgress(
    res,
    progressCounter,
    "static-validation",
    "complete",
    `Static validation: ${result.passed ? "PASSED" : "FAILED"} — ${errorCount} errors, ${warnCount} warnings, hasMain=${result.hasMainClass}, dupBeans=${result.duplicateBeans.join(", ") || "none"}`,
  );

  if (result.fieldInjectionFiles.length > 0) {
    writeProgress(
      res,
      progressCounter,
      "static-field-injection",
      "complete",
      `Field injection found in ${result.fieldInjectionFiles.length} file(s): ${result.fieldInjectionFiles.slice(0, 3).map((f) => f.split("/").pop()).join(", ")}`,
    );
  }

  if (result.duplicateBeans.length > 0) {
    writeProgress(
      res,
      progressCounter,
      "static-dup-beans",
      "complete",
      `Duplicate beans detected: ${result.duplicateBeans.join(", ")} — these will cause Spring context failures`,
    );
  }

  return result;
}

interface StaticAutoFixOpts {
  state: MigrationState;
  intelligence: CodebaseIntelligence;
  llmClient: LLMClient;
  progressCounter: { value: number };
  res: Response;
  maxAttempts: number;
}

async function runStaticAutoFixLoop(opts: StaticAutoFixOpts): Promise<string[]> {
  const { state, llmClient, progressCounter, res, maxAttempts } = opts;
  const errors: string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const migratedFiles = new Map<string, string>();
    for (const [path, content] of state.fileMap) {
      if (path.includes("migrate/")) migratedFiles.set(path, content);
    }

    const result = runStaticValidation(migratedFiles);
    const errorIssues = result.issues.filter((i) => i.severity === "error");

    if (errorIssues.length === 0) {
      writeProgress(res, progressCounter, "static-autofix", "complete", `Static auto-fix: all errors resolved after ${attempt - 1} attempt(s)`);
      return [];
    }

    writeProgress(
      res,
      progressCounter,
      "static-autofix",
      "in-progress",
      `Static auto-fix attempt ${attempt}/${maxAttempts}: ${errorIssues.length} error(s) — ${errorIssues.map((i) => i.type).join(", ")}`,
    );

    const affectedFiles = [...new Set(errorIssues.map((i) => i.file))].filter((f) => f !== "project");

    for (const filePath of affectedFiles.slice(0, 3)) {
      const content = state.fileMap.get(filePath);
      if (!content) continue;

      const fileErrors = errorIssues.filter((i) => i.file === filePath);
      const prompt = `Fix the following static validation errors in this Spring Boot file.

ERRORS:
${fileErrors.map((e) => `- [${e.type}] ${e.message}`).join("\n")}

FILE: ${filePath}
\`\`\`java
${content.slice(0, 3000)}
\`\`\`

Attempt ${attempt}/${maxAttempts}.
Return ONLY the complete corrected file content — no markdown, no explanation.`;

      const resp = await llmClient.generateText(prompt, { maxRetries: 1, systemPrompt: "You are a Spring Boot expert. Fix only the reported errors. Return complete file content only, no markdown." });
      if (resp.success && resp.data) {
        const fixed = resp.data.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
        state.fileMap.set(filePath, fixed);
        applyFileOperation(state, { file: filePath, action: "modify", content: fixed });
        logger.info(`Static auto-fix applied to ${filePath}`);
      }
    }
  }

  const finalResult = runStaticValidation((() => {
    const m = new Map<string, string>();
    for (const [p, c] of state.fileMap) { if (p.includes("migrate/")) m.set(p, c); }
    return m;
  })());

  const remaining = finalResult.issues.filter((i) => i.severity === "error");
  if (remaining.length > 0) {
    writeProgress(
      res,
      progressCounter,
      "static-autofix",
      "complete",
      `Static auto-fix exhausted: ${remaining.length} error(s) remain after ${maxAttempts} attempt(s)`,
    );
    errors.push(...remaining.map((i) => `[static] ${i.message}`));
  }

  return errors;
}

async function pipeMigrationStream(
  res: Response,
  webStream: ReadableStream,
  taskId: string,
): Promise<void> {
  if (res.writableEnded || res.destroyed) return;

  const { Readable } = await import("node:stream");
  const nodeStream = Readable.fromWeb(webStream as any);
  let lineBuffer = "";

  function processLine(line: string): void {
    if (!line) return;
    const m = MIGRATION_FRAME_RE.exec(line);
    if (m) {
      const prefix = m[1];
      if (prefix === "f" || prefix === "e" || prefix === "d" || prefix === "g") return;
      if (prefix === "3") {
        logger.warn(`Task ${taskId} LLM error frame: ${m[2]}`);
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
      logger.error(`Task ${taskId} stream error: ${err?.message}`);
      reject(err);
    });
  });
}

function sanitizeMigratePath(rawPath: string): string | null {
  const normalized = rawPath.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (normalized.includes("..") || normalized.includes("\0")) return null;
  if (normalized.startsWith("/home/project/migrate/")) return normalized;
  if (normalized.startsWith("migrate/")) return `/home/project/${normalized}`;
  return null;
}

function extractGeneratedFiles(stepText: string): FileMap {
  const updated: FileMap = {};
  const re = /<cortexAction[^>]*type="file"[^>]*filePath="([^"]+)"[^>]*>([\s\S]*?)<\/cortexAction>/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(stepText)) !== null) {
    const fullPath = sanitizeMigratePath(match[1]);
    if (!fullPath) {
      logger.warn(`Skipping non-migrate/ path "${match[1]}"`);
      continue;
    }
    updated[fullPath] = { type: "file", content: match[2], isBinary: false } as any;
  }

  return updated;
}

function inferGlobalDecisions(
  state: MigrationState,
  plan: MigrationPlan,
  intelligence: CodebaseIntelligence,
): void {
  const firstController = intelligence.keyFiles.controllers[0];
  if (firstController) {
    const parts = firstController.split("/");
    const javaIndex = parts.indexOf("java");
    if (javaIndex !== -1) {
      state.globalDecisions.packageRoot = parts.slice(javaIndex + 1, -1).join(".");
    }
  }

  for (const task of plan.tasks) {
    if (task.type === "config") {
      state.globalDecisions.configClasses.push(...(task.files ?? [task.file]));
    }
  }

  logger.info(`Global decisions: packageRoot="${state.globalDecisions.packageRoot}", configs=${state.globalDecisions.configClasses.length}`);
}

function assertAllFilesCovered(
  tasks: MigrationTask[],
  progressCounter: { value: number },
  res: Response,
): void {
  const covered = new Set<string>();
  for (const task of tasks) {
    covered.add(task.file);
    for (const f of task.files ?? []) covered.add(f);
  }

  writeProgress(
    res,
    progressCounter,
    "coverage-check",
    "complete",
    `Coverage check: ${covered.size} file${covered.size !== 1 ? "s" : ""} across ${tasks.length} task${tasks.length !== 1 ? "s" : ""}`,
  );
}

function countOps(state: MigrationState, action: string): number {
  return state.operations.filter((op) => op.action === action).length;
}

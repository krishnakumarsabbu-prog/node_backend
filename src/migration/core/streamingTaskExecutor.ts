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
import { normalizeTasks } from "./taskNormalizer";
import { runStaticValidation } from "./staticValidator";
import {
  createMigrationState,
  applyFileOperation,
  markTaskComplete,
  markTaskFailed,
  registerBean,
  serializeGlobalDecisions,
  getChangeSet,
  type MigrationState,
} from "./migrationState";
import { serializeChangeSet, type ChangeSet } from "./diffTracker";
import { LLMClient } from "../llm/llmClient";

const logger = createScopedLogger("streaming-task-executor");

const MIGRATION_FRAME_RE = /^([0-9a-z]+):(.+)\n?$/;
const MAX_TASK_RETRIES = 2;
const MAX_STATIC_FIX_ATTEMPTS = 3;
const QUALITY_FIX_WARNING_THRESHOLD = 3;

const APPROX_CHARS_PER_TOKEN = 4;
const MAX_CONTEXT_TOKENS = 6000;
const MAX_DEP_FILE_CHARS = 1200;
const MAX_CURRENT_FILE_CHARS = 2000;
const MAX_GUIDANCE_CHARS = 1500;
const MAX_DEP_FILES = 5;

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

export interface ConfidenceScore {
  taskSuccessRate: number;
  staticErrorCount: number;
  staticWarningCount: number;
  autoFixAttempts: number;
  qualityFixApplied: boolean;
  overallScore: number;
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
  confidence: ConfidenceScore;
  changeSet: ChangeSet;
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

function computeConfidence(
  taskResults: StreamingTaskResult["taskResults"],
  staticResult: ReturnType<typeof runStaticValidation>,
  autoFixAttempts: number,
  qualityFixApplied: boolean,
): ConfidenceScore {
  const successCount = taskResults.filter((t) => t.success).length;
  const taskSuccessRate = taskResults.length > 0 ? successCount / taskResults.length : 0;
  const staticErrorCount = staticResult.issues.filter((i) => i.severity === "error").length;
  const staticWarningCount = staticResult.issues.filter((i) => i.severity === "warning").length;

  let score = taskSuccessRate * 60;
  score += staticErrorCount === 0 ? 20 : Math.max(0, 20 - staticErrorCount * 5);
  score += staticWarningCount === 0 ? 10 : Math.max(0, 10 - staticWarningCount * 2);
  score += staticResult.hasMainClass ? 5 : 0;
  score += qualityFixApplied ? 5 : 0;

  return {
    taskSuccessRate: Math.round(taskSuccessRate * 100),
    staticErrorCount,
    staticWarningCount,
    autoFixAttempts,
    qualityFixApplied,
    overallScore: Math.round(Math.min(100, score)),
  };
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

  const rawTasks = plan.tasks ?? [];
  const tasks = normalizeTasks(rawTasks);

  if (tasks.length !== rawTasks.length) {
    writeProgress(
      res,
      progressCounter,
      "task-normalization",
      "complete",
      `Task normalization: ${rawTasks.length} tasks → ${tasks.length} per-file tasks`,
    );
  }

  const llmClient = new LLMClient();

  const sourceFiles = new Map<string, string>();
  for (const [path, file] of Object.entries(files)) {
    if (file && "content" in file) {
      sourceFiles.set(path, (file as any).content as string);
    }
  }

  const state = createMigrationState(sourceFiles);
  inferGlobalDecisions(state, plan, intelligence);

  assertAllFilesCovered(tasks, sourceFiles, progressCounter, res);

  const taskGraph = buildTaskGraph(tasks);

  writeProgress(
    res,
    progressCounter,
    "migration-graph",
    "complete",
    `Task graph: ${tasks.length} tasks → ${taskGraph.executionWaves.length} execution wave${taskGraph.executionWaves.length !== 1 ? "s" : ""} (${taskGraph.executionWaves.map((w) => `wave${w.wave}:${w.tasks.length}t`).join(", ")})`,
  );

  writeAnnotation(res, {
    type: "planSteps",
    steps: tasks.map((t, i) => ({
      index: i + 1,
      heading: `[${t.action}] ${t.file.split("/").pop() ?? t.file}`,
    })),
    totalSteps: tasks.length,
    executionMode: "steps",
  });

  const sharedMessageId = generateId();
  res.write(`f:${JSON.stringify({ messageId: sharedMessageId })}\n`);

  const cumulativeUsage = { completionTokens: 0, promptTokens: 0, totalTokens: 0 };
  const taskResults: StreamingTaskResult["taskResults"] = [];
  let autoFixAttempts = 0;

  for (const wave of taskGraph.executionWaves) {
    if (clientAbortSignal?.aborted || res.writableEnded || res.destroyed) break;

    for (const task of wave.tasks) {
      if (clientAbortSignal?.aborted || res.writableEnded || res.destroyed) break;

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
    const fixResult = await runStaticAutoFixLoop({
      state,
      intelligence,
      llmClient,
      progressCounter,
      res,
      maxAttempts: MAX_STATIC_FIX_ATTEMPTS,
    });
    staticFixErrors = fixResult.errors;
    autoFixAttempts = fixResult.attempts;

    if (staticFixErrors.length > 0) {
      const criticalErrors = staticResult.issues
        .filter((i) => i.severity === "error")
        .map((i) => `[${i.type}] ${i.message}`);
      writeAnnotation(res, {
        type: "migration_rollback_recommended",
        reason: `Static validation found ${criticalErrors.length} unresolvable error(s) after ${MAX_STATIC_FIX_ATTEMPTS} auto-fix attempts`,
        errors: criticalErrors.slice(0, 10),
        suggestion: "Review generated files manually or re-run migration with more context",
      });
    }
  }

  const warningCount = staticResult.issues.filter((i) => i.severity === "warning").length;
  let qualityFixApplied = false;
  if (warningCount >= QUALITY_FIX_WARNING_THRESHOLD && staticFixErrors.length === 0) {
    qualityFixApplied = await runQualityImprovementPass({
      state,
      llmClient,
      progressCounter,
      res,
    });
  }

  const finalStaticResult = qualityFixApplied
    ? runPostExecutionStaticValidation(state, progressCounter, res)
    : staticResult;

  const failedTasks = taskResults.filter((t) => !t.success);
  const success = failedTasks.length === 0 && staticFixErrors.length === 0;

  const confidence = computeConfidence(taskResults, finalStaticResult, autoFixAttempts, qualityFixApplied);

  writeProgress(
    res,
    progressCounter,
    "migration-done",
    "complete",
    `Migration complete: ${taskResults.filter((t) => t.success).length}/${tasks.length} tasks succeeded, tokens=${cumulativeUsage.totalTokens}, static=${finalStaticResult.passed ? "PASSED" : "FAILED"}, confidence=${confidence.overallScore}/100`,
  );

  const changeSet = getChangeSet(state);

  writeAnnotation(res, {
    type: "migration_confidence",
    confidence,
  });

  writeAnnotation(res, {
    type: "migration_changeset",
    summary: serializeChangeSet(changeSet),
    createdFiles: changeSet.createdFiles,
    modifiedFiles: changeSet.modifiedFiles,
    deletedFiles: changeSet.deletedFiles,
    totalLinesAdded: changeSet.totalLinesAdded,
    totalLinesRemoved: changeSet.totalLinesRemoved,
  });

  const succeededCount = taskResults.filter((t) => t.success).length;
  const failedCount = taskResults.filter((t) => !t.success).length;
  const allChangedFiles = new Set([...changeSet.createdFiles, ...changeSet.modifiedFiles, ...changeSet.deletedFiles]);
  const silentFailedSteps = taskResults.filter(
    (t) => t.success && !allChangedFiles.has(t.file),
  ).length;
  writeAnnotation(res, {
    type: "planFileSummary",
    createdFiles: changeSet.createdFiles,
    modifiedFiles: changeSet.modifiedFiles,
    succeededSteps: succeededCount,
    failedSteps: failedCount,
    silentFailedSteps,
    totalSteps: tasks.length,
  });

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
    staticIssues: finalStaticResult.issues.map((i) => `[${i.severity.toUpperCase()}] ${i.type}: ${i.message}`),
    taskResults,
    confidence,
    changeSet,
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
    applyFileOperation(state, { file: task.file, action: "delete" }, task.id);
    if (!res.writableEnded && !res.destroyed) {
      res.write(`2:[${JSON.stringify({ type: "file-deleted", filePath: task.file, taskId: task.id })}]\n`);
    }
    writeProgress(
      res,
      progressCounter,
      `migration-task-${task.id}`,
      "complete",
      `Task ${taskIndex}/${totalTasks} done: delete ${task.file}`,
    );
    return { taskId: task.id, file: task.file, success: true };
  }

  const resolvedAction = resolveTaskAction(task, state);
  let lastError: string | undefined;

  for (let attempt = 0; attempt <= MAX_TASK_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoff = 1000 * 2 ** (attempt - 1);
      await new Promise((r) => setTimeout(r, backoff));
      writeProgress(
        res,
        progressCounter,
        `migration-task-${task.id}`,
        "in-progress",
        `Task ${taskIndex}/${totalTasks} retry ${attempt}/${MAX_TASK_RETRIES}: ${task.file}${lastError ? ` (prev: ${lastError.slice(0, 80)})` : ""}`,
      );
    }

    const taskMessages = buildTaskMessages(opts, resolvedAction, lastError);

    try {
      const startMs = Date.now();
      const filesUsed = Array.from(collectDependencyFilesFromGraph(task, state, opts.intelligence).keys());

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
          ? pipeMigrationStream(res, response.body, task.id, progressCounter)
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
      const outputFiles = Object.keys(extractedFiles);

      if (outputFiles.length > 0) {
        for (const [filePath, content] of Object.entries(extractedFiles)) {
          const op: FileOperation = {
            file: filePath,
            action: resolvedAction,
            content: (content as any).content,
          };
          applyFileOperation(state, op, task.id);
          updateGlobalStateFromContent(state, filePath, (content as any).content);

          if (!res.writableEnded && !res.destroyed) {
            const eventType = resolvedAction === "create" ? "file-created" : "file-modified";
            res.write(`2:[${JSON.stringify({ type: eventType, filePath, taskId: task.id })}]\n`);
          }
        }
      } else {
        logger.warn(`Task ${task.id} produced 0 extractable files from response`);
        if (attempt < MAX_TASK_RETRIES) {
          lastError = "no cortexAction blocks extracted from LLM response";
          writeProgress(
            res,
            progressCounter,
            `migration-task-${task.id}`,
            "in-progress",
            `Task ${taskIndex}/${totalTasks} WARNING: no output files — retrying (attempt ${attempt + 1}/${MAX_TASK_RETRIES})`,
          );
          continue;
        }
        writeProgress(
          res,
          progressCounter,
          `migration-task-${task.id}`,
          "complete",
          `Task ${taskIndex}/${totalTasks} FAILED: no cortexAction blocks extracted after ${MAX_TASK_RETRIES + 1} attempts — ${task.file} was not generated`,
        );
        return { taskId: task.id, file: task.file, success: false, error: "no cortexAction blocks extracted from LLM response" };
      }

      logger.info(
        `[obs] task=${task.id} file=${task.file} action=${resolvedAction} ` +
        `deps=[${filesUsed.join(",")}] out=[${outputFiles.join(",")}] ` +
        `tokens=${usage?.totalTokens ?? 0} ms=${Date.now() - startMs} attempt=${attempt}`,
      );

      writeProgress(
        res,
        progressCounter,
        `migration-task-${task.id}`,
        "complete",
        `Task ${taskIndex}/${totalTasks} done [${task.type ?? "code"}]: ${task.file} (${outputFiles.length} file${outputFiles.length !== 1 ? "s" : ""})`,
      );

      return { taskId: task.id, file: task.file, success: true };
    } catch (err: any) {
      lastError = err?.message ?? "unknown error";
      const isRetryable =
        err?.name === "AbortError" ||
        err?.message?.includes("timeout") ||
        err?.message?.includes("ECONNRESET") ||
        err?.message?.includes("socket hang up");

      if (!isRetryable || attempt >= MAX_TASK_RETRIES) {
        logger.error(`Task ${task.id} failed permanently: ${lastError}`);
        writeProgress(
          res,
          progressCounter,
          `migration-task-${task.id}`,
          "complete",
          `Task ${taskIndex}/${totalTasks} FAILED: ${task.file} — ${lastError}`,
        );
        return { taskId: task.id, file: task.file, success: false, error: lastError };
      }
    }
  }

  return { taskId: task.id, file: task.file, success: false, error: lastError ?? "max retries exceeded" };
}

function resolveTaskAction(task: MigrationTask, state: MigrationState): "create" | "modify" {
  if (task.action === "modify") return "modify";
  if (task.action === "create" && state.fileMap.has(task.file)) {
    logger.warn(`Idempotency: task ${task.id} create on existing ${task.file} — upgraded to modify`);
    return "modify";
  }
  return "create";
}

function buildTaskMessages(opts: TaskStreamingOpts, resolvedAction: string, lastError?: string): Messages {
  const { task, state, intelligence, markdownContent } = opts;

  const currentContent = state.fileMap.get(task.file);
  const dependencyFiles = collectDependencyFilesFromGraph(task, state, intelligence);
  const trimmedDeps = trimDependencyFilesToBudget(dependencyFiles, currentContent);

  const sections: string[] = [];
  sections.push(`You are migrating a Spring MVC project to Spring Boot.`);
  sections.push(`\n## TASK`);
  sections.push(`File: ${task.file}`);
  sections.push(`Action: ${resolvedAction}`);
  sections.push(`Type: ${task.type ?? "code"}`);
  sections.push(`Description: ${task.description}`);

  if (task.files && task.files.length > 1) {
    sections.push(`Related files: ${task.files.join(", ")}`);
  }

  if (lastError) {
    sections.push(`\n## PREVIOUS ATTEMPT FAILED`);
    sections.push(`Error: ${lastError}`);
    sections.push(`Fix this specific issue. Do not repeat the same mistake.`);
  }

  sections.push(`\n## MIGRATION STATE`);
  sections.push(serializeGlobalDecisions(state));

  if (trimmedDeps.size > 0) {
    sections.push(`\n## DEPENDENCY FILES (classes this file depends on — from dependency graph)`);
    for (const [path, content] of trimmedDeps) {
      sections.push(`\n### ${path}`);
      sections.push("```java");
      sections.push(content);
      sections.push("```");
    }
  }

  if (currentContent) {
    sections.push(`\n## CURRENT FILE CONTENT (before migration)`);
    sections.push("```java");
    sections.push(currentContent.slice(0, MAX_CURRENT_FILE_CHARS) + (currentContent.length > MAX_CURRENT_FILE_CHARS ? "\n...[truncated]" : ""));
    sections.push("```");
  }

  if (markdownContent) {
    const guidance = extractMarkdownGuidanceForTask(task, markdownContent);
    if (guidance) {
      sections.push(`\n## MIGRATION GUIDANCE (from Migration.md)`);
      sections.push(guidance.slice(0, MAX_GUIDANCE_CHARS));
    }
  }

  appendXmlBeanWiringContext(sections, task, opts.intelligence, opts.files);

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

function trimDependencyFilesToBudget(
  depFiles: Map<string, string>,
  currentContent: string | undefined,
): Map<string, string> {
  const result = new Map<string, string>();
  let usedChars = currentContent ? Math.min(currentContent.length, MAX_CURRENT_FILE_CHARS) : 0;
  const budgetChars = MAX_CONTEXT_TOKENS * APPROX_CHARS_PER_TOKEN;

  for (const [path, content] of depFiles) {
    if (result.size >= MAX_DEP_FILES) break;
    const charsToUse = Math.min(content.length, MAX_DEP_FILE_CHARS);
    if (usedChars + charsToUse > budgetChars) {
      logger.info(`Context budget (${budgetChars} chars) reached at ${result.size} dep files — trimming`);
      break;
    }
    result.set(path, content.slice(0, charsToUse) + (content.length > charsToUse ? "\n...[truncated]" : ""));
    usedChars += charsToUse;
  }

  return result;
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
    const outgoingEdges = intelligence.dependencyGraph.edges.filter(
      (e) => e.from === taskNode.filePath && (e.type === "imports" || (e as any).type === "injects" || (e as any).type === "xml-ref"),
    );

    const prioritized = [
      ...outgoingEdges.filter((e) => (e as any).type === "injects"),
      ...outgoingEdges.filter((e) => (e as any).type === "xml-ref"),
      ...outgoingEdges.filter((e) => e.type === "imports"),
    ];

    for (const edge of prioritized.slice(0, MAX_DEP_FILES)) {
      const content = state.fileMap.get(edge.to);
      if (content) {
        result.set(edge.to, content);
      }
    }
  }

  for (const depId of task.dependsOn ?? []) {
    const depOp = state.operations.find((op) => (op as any).taskId === depId);
    if (depOp?.content && result.size < MAX_DEP_FILES) {
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

function appendXmlBeanWiringContext(
  sections: string[],
  task: MigrationTask,
  intelligence: CodebaseIntelligence,
  files: FileMap,
): void {
  if (intelligence.xmlConfigs.length === 0) return;

  const relevantXmlConfigs = intelligence.xmlConfigs.filter((xml) => {
    if (task.type === "config") return true;
    const taskFileBase = task.file.split("/").pop()?.replace(/\.[^.]+$/, "")?.toLowerCase() ?? "";
    return xml.beans.some((b) =>
      b.id.toLowerCase().includes(taskFileBase) ||
      b.className.toLowerCase().includes(taskFileBase) ||
      b.propertyRefs.some((p) => p.ref.toLowerCase().includes(taskFileBase)) ||
      b.constructorArgs.some((c) => c.ref?.toLowerCase().includes(taskFileBase)),
    );
  });

  if (relevantXmlConfigs.length === 0) return;

  sections.push(`\n## XML BEAN DEFINITIONS (source of truth for wiring — convert ALL to @Bean methods)`);
  for (const xml of relevantXmlConfigs.slice(0, 4)) {
    const xmlFileContent = files[xml.file] && "content" in (files[xml.file] as any)
      ? (files[xml.file] as any).content as string
      : null;

    sections.push(`\n### ${xml.file} [${xml.xmlType}] (${xml.beanCount} beans)`);

    if (xml.beans.length > 0) {
      sections.push(`Bean Definitions:`);
      for (const b of xml.beans.slice(0, 20)) {
        const shortClass = b.className.split(".").pop() ?? b.className;
        sections.push(`  @Bean ${b.id}: ${b.className}`);
        if (b.scope && b.scope !== "singleton") {
          sections.push(`    scope: ${b.scope}`);
        }
        if (b.constructorArgs.length > 0) {
          const ctorArgs = b.constructorArgs.map((c) => c.ref ? `@Autowired ${c.ref}` : `"${c.value ?? "?"}"`);
          sections.push(`    constructor-args: ${ctorArgs.join(", ")} → inject as constructor params`);
        }
        if (b.propertyRefs.length > 0) {
          for (const p of b.propertyRefs) {
            sections.push(`    setProperty(${p.name}) = ref:${p.ref} → inject ${p.ref} as constructor param or setter`);
          }
        }
        if (b.initMethod) sections.push(`    @Bean(initMethod="${b.initMethod}")`);
        if (b.destroyMethod) sections.push(`    @Bean(destroyMethod="${b.destroyMethod}")`);
        if (b.primary) sections.push(`    @Primary`);
        if (b.factoryBean) sections.push(`    factory: ${b.factoryBean}.${b.factoryMethod ?? "create"}()`);
        if (b.parent) {
          const parentBean = xml.beans.find((pb) => pb.id === b.parent);
          if (parentBean) sections.push(`    extends bean: ${b.parent} (${parentBean.className.split(".").pop()}) — class: ${shortClass}`);
          else sections.push(`    extends bean: ${b.parent} — class: ${shortClass}`);
        }
      }
    }

    if (xmlFileContent && task.type === "config") {
      const MAX_XML_CHARS = 2000;
      sections.push(`\nRaw XML source (for complete conversion):`);
      sections.push("```xml");
      sections.push(xmlFileContent.slice(0, MAX_XML_CHARS) + (xmlFileContent.length > MAX_XML_CHARS ? "\n...[truncated]" : ""));
      sections.push("```");
    }
  }
}

function appendStageRules(sections: string[], type: string, state: MigrationState): void {
  const existingBeans = Array.from(state.globalDecisions.beanNames.keys());

  sections.push(`\n## RULES (MANDATORY — NEVER violate)`);
  sections.push(`1. ALWAYS use CONSTRUCTOR INJECTION — NEVER @Autowired/@Inject/@Resource on fields`);
  sections.push(`2. NEVER reference XML files (ClassPathXmlApplicationContext, web.xml, applicationContext.xml, dispatcher-servlet.xml)`);
  sections.push(`3. ALWAYS add the correct stereotype (@Service, @Repository, @Controller, @RestController, @Configuration)`);
  sections.push(`4. NEVER define a bean already registered: ${existingBeans.join(", ") || "(none yet)"}`);
  sections.push(`5. ALWAYS preserve 100% of business logic — NEVER drop methods or fields`);
  sections.push(`6. ALWAYS output files under migrate/`);
  sections.push(`7. ALWAYS wrap output in a <cortexArtifact> with one <cortexAction type="file"> per file — RAW XML, never inside markdown fences`);
  sections.push(`8. NEVER mix XML config with annotation config in the same file`);
  sections.push(`9. NEVER use deprecated Spring APIs (XmlBeanFactory, SimpleFormController, etc.)`);

  switch (type) {
    case "build":
      sections.push(`\n## BUILD RULES`);
      sections.push(`- ALWAYS use spring-boot-starter-parent as parent POM`);
      sections.push(`- ALWAYS include spring-boot-starter-web`);
      sections.push(`- Include spring-boot-starter-data-jpa ONLY if JPA/Hibernate is used`);
      sections.push(`- ALWAYS add spring-boot-maven-plugin`);
      sections.push(`- NEVER include standalone servlet-api or spring-webmvc — covered by starters`);
      break;
    case "config":
      sections.push(`\n## CONFIG RULES`);
      sections.push(`- ALWAYS annotate configuration classes with @Configuration`);
      sections.push(`- ALWAYS replace every <bean> element with a @Bean method — see XML BEAN DEFINITIONS section above`);
      sections.push(`- For <property name="x" ref="y"/>: add parameter "YType y" to the @Bean method and call setX(y)`);
      sections.push(`- NEVER add @EnableWebMvc to the @SpringBootApplication class — use a separate @Configuration`);
      sections.push(`- Servlet Filters → @Bean FilterRegistrationBean<YourFilter>; set order with setOrder()`);
      sections.push(`- HandlerInterceptors → implement WebMvcConfigurer, override addInterceptors(); NEVER register as standalone @Bean`);
      sections.push(`- AOP @Aspect → keep @Component @Aspect; add @EnableAspectJAutoProxy to a @Configuration`);
      sections.push(`- Scheduling → @EnableScheduling on @Configuration; keep @Scheduled methods on the bean`);
      sections.push(`- Async → @EnableAsync on @Configuration; keep @Async methods on the bean`);
      sections.push(`- Security → SecurityFilterChain @Bean inside @Configuration @EnableWebSecurity class`);
      sections.push(`- For <constructor-arg ref="y"/>: add parameter "YType y" to the @Bean method and pass to constructor`);
      sections.push(`- For <constructor-arg value="x"/>: pass literal value to constructor`);
      sections.push(`- For init-method="x": use @Bean(initMethod = "x")`);
      sections.push(`- For destroy-method="x": use @Bean(destroyMethod = "x")`);
      sections.push(`- For primary="true": annotate the @Bean method with @Primary`);
      sections.push(`- For scope="prototype": annotate the @Bean method with @Scope("prototype")`);
      sections.push(`- For factory-bean + factory-method: call the factory bean's method`);
      sections.push(`- ALWAYS replace context:component-scan with @SpringBootApplication or @ComponentScan`);
      sections.push(`- ALWAYS replace property-placeholder with @Value or @ConfigurationProperties`);
      sections.push(`- If replacing web.xml: ALWAYS create @SpringBootApplication main class with SpringApplication.run()`);
      sections.push(`- NEVER copy XML into the target project — convert it to Java`);
      sections.push(`- NEVER leave any <bean> unconverted — every bean in the XML must have a corresponding @Bean method`);
      break;
    case "code":
      sections.push(`\n## CODE RULES`);
      sections.push(`- ALWAYS use appropriate stereotype: @Service, @Repository, @Controller, @RestController`);
      sections.push(`- ALWAYS convert field injection to constructor injection`);
      sections.push(`- NEVER reference Spring XML configuration`);
      break;
    case "resource":
      sections.push(`\n## RESOURCE RULES`);
      sections.push(`- ALWAYS place in migrate/src/main/resources/`);
      sections.push(`- ALWAYS use Spring Boot property key conventions`);
      sections.push(`- NEVER include legacy servlet or container configuration`);
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

  if (content.includes("SecurityFilterChain") && content.includes("@Bean")) {
    if (!state.globalDecisions.securityFilterChainBean) {
      state.globalDecisions.securityFilterChainBean = filePath;
    }
    if (!state.globalDecisions.filterChainBeans.includes(filePath)) {
      state.globalDecisions.filterChainBeans.push(filePath);
    }
  }

  if (content.includes("implements WebMvcConfigurer") && !state.globalDecisions.webMvcConfigurerClass) {
    state.globalDecisions.webMvcConfigurerClass = filePath;
  }

  if (content.includes("FilterRegistrationBean")) {
    const base = filePath.split("/").pop() ?? filePath;
    if (!state.globalDecisions.migratedFilters.includes(base)) {
      state.globalDecisions.migratedFilters.push(base);
    }
  }

  if (content.includes("addInterceptors") || content.includes("implements HandlerInterceptor")) {
    const base = filePath.split("/").pop() ?? filePath;
    if (!state.globalDecisions.migratedInterceptors.includes(base)) {
      state.globalDecisions.migratedInterceptors.push(base);
    }
  }

  if (content.includes("@Aspect")) {
    const base = filePath.split("/").pop() ?? filePath;
    if (!state.globalDecisions.migratedAspects.includes(base)) {
      state.globalDecisions.migratedAspects.push(base);
    }
  }

  if (content.includes("@EnableAspectJAutoProxy")) state.globalDecisions.aopEnabled = true;
  if (content.includes("@EnableScheduling")) state.globalDecisions.schedulingEnabled = true;
  if (content.includes("@EnableAsync")) state.globalDecisions.asyncEnabled = true;
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
        `Stage validation [${stage}]: wave ${waveIndex} — ${waveTasks.filter((t) => state.completedTasks.has(t.id)).length}/${waveTasks.length} tasks succeeded, beans=${state.globalDecisions.beanNames.size}`,
      );
    }
  }
}

function runPostExecutionStaticValidation(
  state: MigrationState,
  progressCounter: { value: number },
  res: Response,
): ReturnType<typeof runStaticValidation> {
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

function emitFixedFile(res: Response, filePath: string, content: string, label: string): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`2:[${JSON.stringify({ type: "file-modified", filePath, taskId: label })}]\n`);
  const artifact =
    `<cortexArtifact id="${label}-${filePath.split("/").pop()}" title="${filePath.split("/").pop()}">` +
    `<cortexAction type="file" filePath="${filePath}">` +
    content +
    `</cortexAction></cortexArtifact>`;
  const chunks = artifact.match(/.{1,500}/gs) ?? [artifact];
  for (const chunk of chunks) {
    if (!res.writableEnded && !res.destroyed) res.write(`0:${JSON.stringify(chunk)}\n`);
  }
}

interface StaticAutoFixOpts {
  state: MigrationState;
  intelligence: CodebaseIntelligence;
  llmClient: LLMClient;
  progressCounter: { value: number };
  res: Response;
  maxAttempts: number;
}

async function runStaticAutoFixLoop(opts: StaticAutoFixOpts): Promise<{ errors: string[]; attempts: number }> {
  const { state, llmClient, progressCounter, res, maxAttempts } = opts;
  const errors: string[] = [];
  let attemptsUsed = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attemptsUsed = attempt;
    const migratedFiles = new Map<string, string>();
    for (const [path, content] of state.fileMap) {
      if (path.includes("migrate/")) migratedFiles.set(path, content);
    }

    const result = runStaticValidation(migratedFiles);
    const errorIssues = result.issues.filter((i) => i.severity === "error");

    if (errorIssues.length === 0) {
      writeProgress(res, progressCounter, "static-autofix", "complete", `Static auto-fix: all errors resolved after ${attempt - 1} attempt(s)`);
      return { errors: [], attempts: attemptsUsed };
    }

    writeProgress(
      res,
      progressCounter,
      "static-autofix",
      "in-progress",
      `Static auto-fix attempt ${attempt}/${maxAttempts}: ${errorIssues.length} error(s) — ${errorIssues.map((i) => i.type).join(", ")}`,
    );

    const affectedFiles = [...new Set(errorIssues.map((i) => i.file))].filter((f) => f !== "project");
    const batchFiles = affectedFiles.slice(0, 5);

    const batchSections: string[] = [];
    batchSections.push(`Fix the following static validation errors across ${batchFiles.length} Spring Boot file(s).`);
    batchSections.push(`\nRULES (MANDATORY):`);
    batchSections.push(`- NEVER use field injection — ALWAYS constructor injection`);
    batchSections.push(`- NEVER reference XML files — ALWAYS Spring Boot annotations`);
    batchSections.push(`- ALWAYS include SpringApplication.run() if @SpringBootApplication is present`);
    batchSections.push(`- NEVER change business logic`);
    batchSections.push(`\nReturn a JSON object where each key is the exact file path and the value is the complete corrected file content.`);
    batchSections.push(`Format: { "path/to/File.java": "...complete file content...", ... }`);
    batchSections.push(`Return ONLY valid JSON — no markdown fences, no explanation.\n`);

    for (const filePath of batchFiles) {
      const content = state.fileMap.get(filePath);
      if (!content) continue;
      const fileErrors = errorIssues.filter((i) => i.file === filePath);
      batchSections.push(`FILE: ${filePath}`);
      batchSections.push(`ERRORS:`);
      batchSections.push(fileErrors.map((e) => `  - [${e.type}] ${e.message}`).join("\n"));
      batchSections.push("```java");
      batchSections.push(content.slice(0, 2000) + (content.length > 2000 ? "\n...[truncated]" : ""));
      batchSections.push("```\n");
    }

    const batchPrompt = batchSections.join("\n");
    const resp = await llmClient.generateText(batchPrompt, {
      maxRetries: 1,
      systemPrompt: "You are a Spring Boot expert. Fix reported errors across multiple files. Return a single JSON object mapping file paths to complete corrected content. No markdown, no explanation.",
    });

    if (resp.success && resp.data) {
      let jsonText = resp.data.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
      try {
        const fixes: Record<string, string> = JSON.parse(jsonText);
        for (const [filePath, fixedContent] of Object.entries(fixes)) {
          if (typeof fixedContent !== "string" || !fixedContent.trim()) continue;
          state.fileMap.set(filePath, fixedContent);
          applyFileOperation(state, { file: filePath, action: "modify", content: fixedContent });
          emitFixedFile(res, filePath, fixedContent, `autofix-${attempt}`);
          logger.info(`Batch static auto-fix applied to ${filePath} (attempt ${attempt})`);
        }
      } catch {
        logger.warn(`Batch static fix response was not valid JSON — falling back to per-file strip`);
        const singleFixed = jsonText.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
        if (batchFiles.length === 1) {
          const singlePath = batchFiles[0];
          state.fileMap.set(singlePath, singleFixed);
          applyFileOperation(state, { file: singlePath, action: "modify", content: singleFixed });
          emitFixedFile(res, singlePath, singleFixed, `autofix-${attempt}`);
        }
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

  return { errors, attempts: attemptsUsed };
}

interface QualityFixOpts {
  state: MigrationState;
  llmClient: LLMClient;
  progressCounter: { value: number };
  res: Response;
}

async function runQualityImprovementPass(opts: QualityFixOpts): Promise<boolean> {
  const { state, llmClient, progressCounter, res } = opts;

  const migratedFiles = new Map<string, string>();
  for (const [path, content] of state.fileMap) {
    if (path.includes("migrate/") && path.endsWith(".java")) {
      migratedFiles.set(path, content);
    }
  }

  const result = runStaticValidation(migratedFiles);
  const warningIssues = result.issues.filter((i) => i.severity === "warning");

  const fileWarningMap = new Map<string, string[]>();
  for (const issue of warningIssues) {
    if (issue.file === "project") continue;
    const existing = fileWarningMap.get(issue.file) ?? [];
    existing.push(issue.message);
    fileWarningMap.set(issue.file, existing);
  }

  if (fileWarningMap.size === 0) return false;

  writeProgress(
    res,
    progressCounter,
    "quality-pass",
    "in-progress",
    `Quality improvement pass: ${fileWarningMap.size} file(s) with ${warningIssues.length} warning(s)`,
  );

  let anyFixed = false;
  for (const [path, warnings] of Array.from(fileWarningMap.entries()).slice(0, 5)) {
    const content = state.fileMap.get(path);
    if (!content) continue;

    const prompt = `Improve this Spring Boot file by fixing all quality warnings. NEVER change business logic.

WARNINGS:
${warnings.map((w) => `- ${w}`).join("\n")}

RULES:
- ALWAYS use constructor injection — NEVER field injection
- ALWAYS remove XML context references
- NEVER change business logic
- NEVER add or remove methods unrelated to the warnings

FILE: ${path}
\`\`\`java
${content.slice(0, 3000)}
\`\`\`

Return ONLY the improved file content — no markdown, no explanation.`;

    const resp = await llmClient.generateText(prompt, {
      maxRetries: 1,
      systemPrompt: "You are a Spring Boot code quality expert. Fix quality warnings only. Return complete file content only.",
    });

    if (resp.success && resp.data) {
      const improved = resp.data.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "").trim();
      state.fileMap.set(path, improved);
      applyFileOperation(state, { file: path, action: "modify", content: improved });
      emitFixedFile(res, path, improved, "quality-pass");
      logger.info(`Quality improvement applied to ${path}`);
      anyFixed = true;
    }
  }

  if (anyFixed) {
    writeProgress(
      res,
      progressCounter,
      "quality-pass",
      "complete",
      `Quality improvement pass complete: ${fileWarningMap.size} file(s) processed`,
    );
  }

  return anyFixed;
}

async function pipeMigrationStream(
  res: Response,
  webStream: ReadableStream,
  taskId: string,
  progressCounter?: { value: number },
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
        if (progressCounter && !res.writableEnded && !res.destroyed) {
          const errMsg = (() => { try { return JSON.parse(m[2]); } catch { return m[2]; } })();
          const text = typeof errMsg === "string" ? errMsg : (errMsg?.message ?? JSON.stringify(errMsg));
          res.write(`2:[${JSON.stringify({ type: "progress", label: `llm-error-${taskId}`, status: "complete", order: progressCounter.value++, message: `LLM error in task ${taskId}: ${text.slice(0, 200)}` })}]\n`);
        }
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
      logger.warn(`Dropping generated file with non-migrate/ path "${match[1]}" — LLM must output files under migrate/`);
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

  for (const xmlConfig of intelligence.xmlConfigs) {
    for (const bean of xmlConfig.beans ?? []) {
      if (bean.id && bean.id !== "anonymous") {
        registerBean(state, bean.id, xmlConfig.file);
      }
    }
    if (xmlConfig.file.includes("migrate/")) {
      state.globalDecisions.removedXmlFiles.push(xmlConfig.file);
    }
  }

  for (const fs of intelligence.fileSummaries) {
    if (!["service", "repository", "controller"].includes(fs.role)) continue;
    const className = fs.classNames[0];
    if (!className) continue;
    const beanName = className.charAt(0).toLowerCase() + className.slice(1);
    if (!state.globalDecisions.beanNames.has(beanName)) {
      registerBean(state, beanName, fs.path);
    }
  }

  logger.info(`Global decisions: packageRoot="${state.globalDecisions.packageRoot}", configs=${state.globalDecisions.configClasses.length}, pre-seeded beans=${state.globalDecisions.beanNames.size}`);
}

function assertAllFilesCovered(
  tasks: MigrationTask[],
  sourceFiles: Map<string, string>,
  progressCounter: { value: number },
  res: Response,
): void {
  const covered = new Set<string>();
  for (const task of tasks) {
    covered.add(task.file);
    for (const f of task.files ?? []) covered.add(f);
  }

  const SKIP_EXTENSIONS = new Set([".json", ".md", ".txt", ".lock", ".gitignore", ".env"]);
  const skipPaths = ["/home/project/tasks.json", "/home/project/migration.md"];
  const uncovered: string[] = [];
  for (const srcPath of sourceFiles.keys()) {
    if (skipPaths.includes(srcPath)) continue;
    const ext = srcPath.slice(srcPath.lastIndexOf("."));
    if (SKIP_EXTENSIONS.has(ext)) continue;
    if (!covered.has(srcPath)) uncovered.push(srcPath);
  }

  const uncoveredMsg = uncovered.length > 0
    ? ` WARNING: ${uncovered.length} source file${uncovered.length !== 1 ? "s" : ""} not covered by any task: ${uncovered.slice(0, 5).join(", ")}${uncovered.length > 5 ? ` …+${uncovered.length - 5} more` : ""}`
    : "";

  writeProgress(
    res,
    progressCounter,
    "coverage-check",
    "complete",
    `Coverage check: ${covered.size} file${covered.size !== 1 ? "s" : ""} across ${tasks.length} task${tasks.length !== 1 ? "s" : ""}${uncoveredMsg}`,
  );
}

function countOps(state: MigrationState, action: string): number {
  return state.operations.filter((op) => op.action === action).length;
}

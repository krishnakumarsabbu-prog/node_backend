import type { Response } from "express";
import { generateId } from "ai";
import { MigrationRunner } from "../migration/core/migrationRunner";
import { executeTaskGraphStreaming } from "../migration/core/streamingTaskExecutor";
import type { MigrationPlan } from "../migration/types/migrationTypes";
import type { FileMap } from "../llm/constants";
import type { Messages, StreamingOptions } from "../llm/stream-text";
import type { ProgressAnnotation, ContextAnnotation } from "../types/context";
import { AnalyzerAgent } from "../migration/agents/analyzerAgent";
import { buildCodebaseIntelligence, type CodebaseIntelligence } from "../migration/intelligence/contextBuilder";
import { createScopedLogger } from "../utils/logger";

const logger = createScopedLogger("chat-migration");

export interface MigrationRequest {
  files: FileMap;
  messages: Messages;
  workDir: string;
  migrationAction?: "plan" | "implement";
}

function computeFileMapHash(files: FileMap): string {
  const paths = Object.keys(files).sort();
  let hash = 0;
  for (const p of paths) {
    const content = (files[p] as any)?.content ?? "";
    for (let i = 0; i < Math.min(content.length, 512); i++) {
      hash = ((hash << 5) - hash + content.charCodeAt(i)) | 0;
    }
  }
  return `${paths.length}:${hash >>> 0}`;
}

export class ChatMigrationHandler {
  private runner: MigrationRunner;
  private cachedIntelligence: CodebaseIntelligence | null = null;
  private cachedFilesHash: string | null = null;

  constructor(workDir: string, enableVerification = false) {
    this.runner = new MigrationRunner({
      workDir,
      enableVerification,
      enableAutoRepair: enableVerification,
      enableStaticValidation: true,
      maxRepairAttempts: 5,
    });
  }

  async handlePlanGeneration(
    request: MigrationRequest,
    writeDataPart: (res: Response, data: unknown) => void,
    writeMessageAnnotationPart: (res: Response, data: unknown) => void,
    res: Response,
    progressCounter: number,
  ): Promise<number> {
    logger.info("Handling migration plan generation");

    const userMessage = request.messages[request.messages.length - 1];
    const userRequest = typeof userMessage.content === "string" ? userMessage.content : "";

    try {
      writeDataPart(res, {
        type: "progress",
        label: "migration-analyze",
        status: "in-progress",
        order: progressCounter++,
        message: "Step 1/4 — Analysing project structure...",
      } satisfies ProgressAnnotation);

      const analyzerAgent = new AnalyzerAgent();
      const analysis = await analyzerAgent.analyze(request.files);

      writeDataPart(res, {
        type: "progress",
        label: "migration-analyze",
        status: "complete",
        order: progressCounter++,
        message: `Step 1/4 — Analysis complete: framework=${analysis.framework}, buildTool=${analysis.buildTool}, controllers=${analysis.controllers.length}, services=${analysis.services.length}, xmlConfigs=${analysis.xmlConfigs.length}`,
      } satisfies ProgressAnnotation);

      writeDataPart(res, {
        type: "progress",
        label: "migration-intelligence",
        status: "in-progress",
        order: progressCounter++,
        message: "Step 2/4 — Building codebase intelligence (dependency graph, XML parsing, pattern detection)...",
      } satisfies ProgressAnnotation);

      const intelligence = buildCodebaseIntelligence(request.files, analysis);
      this.cachedIntelligence = intelligence;
      this.cachedFilesHash = computeFileMapHash(request.files);

      const patternList = intelligence.migrationPatterns.length > 0
        ? intelligence.migrationPatterns.join(", ")
        : "none";
      writeDataPart(res, {
        type: "progress",
        label: "migration-intelligence",
        status: "complete",
        order: progressCounter++,
        message: `Step 2/4 — Intelligence ready: ${intelligence.fileSummaries.length} files summarised, ${intelligence.xmlConfigs.length} XML configs parsed, ${intelligence.dependencyGraph.edges.length} dependency edges, patterns=[${patternList}]`,
      } satisfies ProgressAnnotation);

      const cycleCount = intelligence.graphSummary.circularDependencies;
      if (cycleCount > 0) {
        writeDataPart(res, {
          type: "progress",
          label: "migration-warning",
          status: "complete",
          order: progressCounter++,
          message: `WARNING: ${cycleCount} circular dependenc${cycleCount === 1 ? "y" : "ies"} detected in project. These must be resolved during migration. Paths: ${intelligence.graphSummary.circularPaths.map((p) => p.map((f) => f.split("/").pop()).join(" → ")).slice(0, 3).join("; ")}`,
        } satisfies ProgressAnnotation);
      }

      if (intelligence.patterns.usesFieldInjection) {
        writeDataPart(res, {
          type: "progress",
          label: "migration-warning",
          status: "complete",
          order: progressCounter++,
          message: "WARNING: Field injection (@Autowired on fields) detected. Migration will convert to constructor injection.",
        } satisfies ProgressAnnotation);
      }

      writeDataPart(res, {
        type: "progress",
        label: "migration-plan",
        status: "in-progress",
        order: progressCounter++,
        message: "Step 3/4 — Generating migration plan (LLM call: document + task graph)...",
      } satisfies ProgressAnnotation);

      const { markdownContent, plan } = await this.runner.generateMigrationDocument(
        request.files,
        userRequest,
        analysis,
      );

      writeDataPart(res, {
        type: "progress",
        label: "migration-plan",
        status: "complete",
        order: progressCounter++,
        message: `Step 3/4 — Plan generated: ${plan.tasks.length} tasks, type=${plan.migrationType}, complexity=${plan.estimatedComplexity || "medium"}`,
      } satisfies ProgressAnnotation);

      writeDataPart(res, {
        type: "progress",
        label: "migration-stream",
        status: "in-progress",
        order: progressCounter++,
        message: "Step 4/4 — Writing migration.md and tasks.json to project...",
      } satisfies ProgressAnnotation);

      const messageId = generateId();
      res.write(`f:${JSON.stringify({ messageId })}\n`);

      const tasksJson = JSON.stringify({
        migrationType: plan.migrationType,
        estimatedComplexity: plan.estimatedComplexity,
        summary: plan.summary,
        tasks: plan.tasks,
      }, null, 2);
      const mdBlock = `<cortexArtifact id="migration-plan" title="Migration Plan">
<cortexAction type="file" filePath="/home/project/migration.md" contentType="text/markdown">
${markdownContent}
</cortexAction>
</cortexArtifact>`;
      const tasksBlock = `<cortexArtifact id="migration-tasks" title="Migration Tasks">
<cortexAction type="file" filePath="/home/project/tasks.json" contentType="application/json">
${tasksJson}
</cortexAction>
</cortexArtifact>`;
      const combined = `${mdBlock}\n\n${tasksBlock}`;

      const chunks = combined.match(/.{1,500}/gs) ?? [combined];
      for (const chunk of chunks) {
        if (!res.writableEnded && !res.destroyed) {
          res.write(`0:${JSON.stringify(chunk)}\n`);
        }
      }

      res.write(
        `e:${JSON.stringify({ finishReason: "stop", usage: { promptTokens: 0, completionTokens: 0 } })}\n`,
      );

      logger.info(`[migration-plan] Wrote migration.md (${markdownContent.length} chars) and tasks.json (${plan.tasks.length} tasks) as cortexArtifact blocks`);

      writeMessageAnnotationPart(res, {
        type: "migration_plan",
        plan: {
          migrationType: plan.migrationType,
          summary: plan.summary,
          tasks: plan.tasks,
          estimatedComplexity: plan.estimatedComplexity,
        },
        migrationDocument: markdownContent,
      } as ContextAnnotation);

      writeMessageAnnotationPart(res, {
        type: "usage",
        value: { completionTokens: 0, promptTokens: 0, totalTokens: 0 },
      });

      const taskBreakdown = `modify=${plan.summary.filesToModify}, create=${plan.summary.filesToCreate}, delete=${plan.summary.filesToDelete}`;
      writeDataPart(res, {
        type: "progress",
        label: "migration-stream",
        status: "complete",
        order: progressCounter++,
        message: `Step 4/4 — Done. migration.md and tasks.json written. Tasks: ${taskBreakdown}. Complexity: ${plan.estimatedComplexity || "medium"}. Review migration.md then click Implement Migration to proceed.`,
      } satisfies ProgressAnnotation);

      logger.info(`Migration plan generated for ${plan.migrationType} migration`);
    } catch (error) {
      logger.error(`Plan generation failed: ${(error as Error).message}`);

      writeDataPart(res, {
        type: "progress",
        label: "migration-error",
        status: "complete",
        order: progressCounter++,
        message: `Plan generation failed: ${(error as Error).message}`,
      } satisfies ProgressAnnotation);

      throw error;
    }

    return progressCounter;
  }

  async handlePlanExecution(
    request: MigrationRequest,
    writeDataPart: (res: Response, data: unknown) => void,
    writeMessageAnnotationPart: (res: Response, data: unknown) => void,
    res: Response,
    progressCounter: number,
    apiKeys?: Record<string, string>,
    providerSettings?: Record<string, any>,
    streamingOptions?: StreamingOptions,
  ): Promise<number> {
    logger.info("Handling migration plan execution");

    const tasksFile = request.files["/home/project/tasks.json"];
    const markdownFile = request.files["/home/project/migration.md"];

    if (!tasksFile || !("content" in tasksFile)) {
      throw new Error("tasks.json not found in project files — run Plan Migration first");
    }

    let plan: MigrationPlan;
    try {
      const parsed = JSON.parse((tasksFile as any).content as string);
      const rawTasks = Array.isArray(parsed) ? parsed : (parsed.tasks ?? []);
      const migrationType = Array.isArray(parsed) ? "spring-mvc-to-boot" : (parsed.migrationType ?? "spring-mvc-to-boot");
      const estimatedComplexity = Array.isArray(parsed)
        ? (rawTasks.length > 20 ? "high" : rawTasks.length > 8 ? "medium" : "low")
        : (parsed.estimatedComplexity ?? (rawTasks.length > 20 ? "high" : rawTasks.length > 8 ? "medium" : "low"));
      plan = {
        migrationType,
        estimatedComplexity,
        summary: Array.isArray(parsed)
          ? {
              filesToModify: rawTasks.filter((t: any) => t.action === "modify").length,
              filesToCreate: rawTasks.filter((t: any) => t.action === "create").length,
              filesToDelete: rawTasks.filter((t: any) => t.action === "delete").length,
            }
          : (parsed.summary ?? {
              filesToModify: rawTasks.filter((t: any) => t.action === "modify").length,
              filesToCreate: rawTasks.filter((t: any) => t.action === "create").length,
              filesToDelete: rawTasks.filter((t: any) => t.action === "delete").length,
            }),
        tasks: rawTasks,
      };
    } catch {
      throw new Error("tasks.json is not valid JSON — re-run Plan Migration to regenerate");
    }

    const migrationDocument: string | undefined =
      markdownFile && "content" in markdownFile ? (markdownFile as any).content as string : undefined;

    const tasks = plan.tasks || [];

    writeDataPart(res, {
      type: "progress",
      label: "migration-execute-start",
      status: "in-progress",
      order: progressCounter++,
      message: `Starting migration implementation — ${tasks.length} tasks in task graph (no re-parsing step), output under migrate/`,
    } satisfies ProgressAnnotation);

    if (apiKeys && streamingOptions) {
      let intelligence = this.cachedIntelligence;
      const currentHash = computeFileMapHash(request.files);
      const cacheValid = intelligence !== null && this.cachedFilesHash === currentHash;

      if (cacheValid && intelligence) {
        writeDataPart(res, {
          type: "progress",
          label: "migration-intelligence",
          status: "complete",
          order: progressCounter++,
          message: `Using cached codebase intelligence (hash match): ${intelligence.fileSummaries.length} files, ${intelligence.xmlConfigs.length} XML configs, patterns=[${intelligence.migrationPatterns.join(", ")}]`,
        } satisfies ProgressAnnotation);
      } else {
        if (intelligence && !cacheValid) {
          writeDataPart(res, {
            type: "progress",
            label: "migration-intelligence",
            status: "in-progress",
            order: progressCounter++,
            message: "File set changed since plan phase — rebuilding codebase intelligence to stay in sync...",
          } satisfies ProgressAnnotation);
        } else {
          writeDataPart(res, {
            type: "progress",
            label: "migration-intelligence",
            status: "in-progress",
            order: progressCounter++,
            message: "Rebuilding codebase intelligence (no cache from plan phase)...",
          } satisfies ProgressAnnotation);
        }

        const analyzerAgent = new AnalyzerAgent();
        const analysis = await analyzerAgent.analyze(request.files);
        intelligence = buildCodebaseIntelligence(request.files, analysis);
        this.cachedIntelligence = intelligence;
        this.cachedFilesHash = currentHash;

        writeDataPart(res, {
          type: "progress",
          label: "migration-intelligence",
          status: "complete",
          order: progressCounter++,
          message: `Intelligence ready: ${intelligence.fileSummaries.length} files, ${intelligence.xmlConfigs.length} XML configs, patterns=[${intelligence.migrationPatterns.join(", ")}]`,
        } satisfies ProgressAnnotation);
      }

      const progressRef = { value: progressCounter };

      writeDataPart(res, {
        type: "progress",
        label: "migration-graph-exec",
        status: "in-progress",
        order: progressRef.value++,
        message: `Executing task graph directly: ${tasks.length} tasks, dependency-ordered, with global state tracking and static validation`,
      } satisfies ProgressAnnotation);

      const execResult = await executeTaskGraphStreaming({
        res,
        plan,
        files: request.files,
        messages: request.messages,
        intelligence,
        markdownContent: migrationDocument,
        streamingOptions,
        apiKeys,
        providerSettings: providerSettings ?? {},
        progressCounter: progressRef,
        clientAbortSignal: undefined,
      });

      progressCounter = progressRef.value;

      const successLabel = execResult.success ? "SUCCESS" : "PARTIAL";
      writeDataPart(res, {
        type: "progress",
        label: "migration-summary",
        status: "complete",
        order: progressCounter++,
        message: `[${successLabel}] created=${execResult.filesCreated}, modified=${execResult.filesModified}, deleted=${execResult.filesDeleted}, tokens=${execResult.totalTokens}, errors=${execResult.errors.length}, staticIssues=${execResult.staticIssues.length}`,
      } satisfies ProgressAnnotation);

      if (execResult.errors.length > 0) {
        writeDataPart(res, {
          type: "progress",
          label: "migration-errors",
          status: "complete",
          order: progressCounter++,
          message: `Errors: ${execResult.errors.slice(0, 5).join(" | ")}`,
        } satisfies ProgressAnnotation);
      }

      writeMessageAnnotationPart(res, {
        type: "migration_result",
        result: {
          success: execResult.success,
          filesModified: execResult.filesModified,
          filesCreated: execResult.filesCreated,
          filesDeleted: execResult.filesDeleted,
          totalTokens: execResult.totalTokens,
          errors: execResult.errors,
          staticIssues: execResult.staticIssues,
          taskResults: execResult.taskResults,
          note: execResult.success
            ? "Execution complete. Run `mvn clean package` in migrate/ to verify the build."
            : `Execution finished with ${execResult.errors.length} error(s). Review errors above.`,
        },
      } as ContextAnnotation);

      writeMessageAnnotationPart(res, {
        type: "usage",
        value: { completionTokens: execResult.totalTokens, promptTokens: 0, totalTokens: execResult.totalTokens },
      });
    } else {
      const progressRef = { value: progressCounter };
      progressRef.value = await this.executeWithRunner(
        plan,
        request.files,
        writeDataPart,
        writeMessageAnnotationPart,
        res,
        progressRef.value,
        migrationDocument,
      );
      progressCounter = progressRef.value;
    }

    return progressCounter;
  }

  private async executeWithRunner(
    plan: MigrationPlan,
    files: FileMap,
    writeDataPart: (res: Response, data: unknown) => void,
    writeMessageAnnotationPart: (res: Response, data: unknown) => void,
    res: Response,
    progressCounter: number,
    migrationDocument?: string,
  ): Promise<number> {
    const tasks = plan.tasks || [];

    writeDataPart(res, {
      type: "progress",
      label: "migration-runner-start",
      status: "in-progress",
      order: progressCounter++,
      message: `Runner mode: executing ${tasks.length} tasks via MigrationExecutor (topological order, up to 4 parallel)...`,
    } satisfies ProgressAnnotation);

    let completedTasks = 0;
    let failedTasks = 0;

    try {
      const result = await this.runner.executePlan(plan, files, this.cachedIntelligence ?? undefined, migrationDocument);

      for (const op of result.operations) {
        const taskIdx = tasks.findIndex((t) => t.file === op.file);
        const displayIdx = taskIdx >= 0 ? taskIdx + 1 : completedTasks + 1;

        if (op.action !== "delete" && !op.content) {
          failedTasks++;
          writeDataPart(res, {
            type: "progress",
            label: `migration-task-${displayIdx}`,
            status: "complete",
            order: progressCounter++,
            message: `Task ${displayIdx}/${tasks.length} FAILED — ${op.action} ${op.file} (no content generated)`,
          } satisfies ProgressAnnotation);
        } else {
          completedTasks++;
          writeDataPart(res, {
            type: "progress",
            label: `migration-task-${displayIdx}`,
            status: "complete",
            order: progressCounter++,
            message: `Task ${displayIdx}/${tasks.length} done — ${op.action} ${op.file}`,
          } satisfies ProgressAnnotation);
        }
      }

      if (result.errors.length > 0) {
        for (const err of result.errors) {
          writeDataPart(res, {
            type: "progress",
            label: "migration-task-error",
            status: "complete",
            order: progressCounter++,
            message: `Error: ${err}`,
          } satisfies ProgressAnnotation);
        }
      }

      const staticIssues = result.errors.filter((e) => e.startsWith("[static]"));
      if (staticIssues.length > 0) {
        writeDataPart(res, {
          type: "progress",
          label: "migration-static-validation",
          status: "complete",
          order: progressCounter++,
          message: `Static validation found ${staticIssues.length} issue(s): ${staticIssues.slice(0, 3).join("; ")}`,
        } satisfies ProgressAnnotation);
      } else {
        writeDataPart(res, {
          type: "progress",
          label: "migration-static-validation",
          status: "complete",
          order: progressCounter++,
          message: "Static validation passed — no field injection, XML reference, or missing @SpringBootApplication issues found",
        } satisfies ProgressAnnotation);
      }

      if (result.rolledBack) {
        writeDataPart(res, {
          type: "progress",
          label: "migration-rollback",
          status: "complete",
          order: progressCounter++,
          message: "Migration ROLLED BACK: execution failed and all changes were reverted to pre-migration state.",
        } satisfies ProgressAnnotation);
      }

      const summary = result.success
        ? `Migration complete: ${result.filesModified} modified, ${result.filesCreated} created, ${result.filesDeleted} deleted${result.frameworkWarning ? ` — WARNING: ${result.frameworkWarning}` : ""}`
        : `Migration finished with ${result.errors.length} error(s). Check error messages above.`;

      writeDataPart(res, {
        type: "progress",
        label: "migration-runner-done",
        status: "complete",
        order: progressCounter++,
        message: summary,
      } satisfies ProgressAnnotation);

      const modifiedFiles: Record<string, string> = {};
      const createdFiles: Record<string, string> = {};
      const deletedFiles: string[] = [];

      for (const op of result.operations) {
        if (op.action === "modify" && op.content) {
          modifiedFiles[op.file] = op.content;
        } else if (op.action === "create" && op.content) {
          createdFiles[op.file] = op.content;
        } else if (op.action === "delete") {
          deletedFiles.push(op.file);
        }
      }

      writeMessageAnnotationPart(res, {
        type: "migration_result",
        result: {
          success: result.success,
          filesModified: result.filesModified,
          filesCreated: result.filesCreated,
          filesDeleted: result.filesDeleted,
          modifiedFiles,
          createdFiles,
          deletedFiles,
          errors: result.errors,
          rolledBack: result.rolledBack ?? false,
          frameworkWarning: result.frameworkWarning,
        },
      } as ContextAnnotation);

      logger.info(
        `Runner execution complete: ${result.filesModified} modified, ${result.filesCreated} created, ${result.filesDeleted} deleted, success=${result.success}`,
      );
    } catch (error) {
      logger.error(`Runner execution failed: ${(error as Error).message}`);

      writeDataPart(res, {
        type: "progress",
        label: "migration-runner-error",
        status: "complete",
        order: progressCounter++,
        message: `Execution failed: ${(error as Error).message}`,
      } satisfies ProgressAnnotation);

      throw error;
    }

    return progressCounter;
  }
}

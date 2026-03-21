import type { MigrationPlan, MigrationResult, FileOperation, MigrationTask } from "../types/migrationTypes";
import type { FileMap } from "../../llm/constants";
import type { CodebaseIntelligence } from "../intelligence/contextBuilder";
import { CodingAgent, type TaskExecutionContext } from "../agents/codingAgent";
import {
  createMigrationState,
  applyFileOperation,
  markTaskComplete,
  markTaskFailed,
  registerBean,
  type MigrationState,
} from "./migrationState";
import { buildTaskGraph, type ExecutionWave } from "./taskGraph";
import { createScopedLogger } from "../../utils/logger";

const logger = createScopedLogger("migration-executor");

const MAX_PARALLEL = 4;

export class MigrationExecutor {
  private fileLocks = new Map<string, Promise<void>>();

  constructor(private codingAgent: CodingAgent) {}

  async execute(
    plan: MigrationPlan,
    files: FileMap,
    intelligence?: CodebaseIntelligence,
    markdownContent?: string
  ): Promise<MigrationResult> {
    logger.info(`Starting orchestrated migration execution: ${plan.tasks.length} tasks`);

    const sourceFiles = new Map<string, string>();
    for (const [path, file] of Object.entries(files)) {
      if (file && "content" in file) {
        sourceFiles.set(path, (file as any).content as string);
      }
    }

    const state = createMigrationState(sourceFiles);

    this.inferGlobalDecisions(state, plan, intelligence);

    const taskGraph = buildTaskGraph(plan.tasks);
    logger.info(
      `Execution graph: ${taskGraph.executionWaves.length} waves, ` +
      taskGraph.executionWaves.map((w) => `wave${w.wave}(${w.tasks.length}t)`).join(" → ")
    );

    for (const wave of taskGraph.executionWaves) {
      await this.executeWave(wave, state, intelligence, markdownContent);
    }

    const result = this.buildResult(state, plan.tasks);

    logger.info(
      `Execution complete: ${result.filesCreated} created, ${result.filesModified} modified, ` +
      `${result.filesDeleted} deleted, ${result.errors.length} errors`
    );

    return result;
  }

  private async executeWave(
    wave: ExecutionWave,
    state: MigrationState,
    intelligence: CodebaseIntelligence | undefined,
    markdownContent: string | undefined
  ): Promise<void> {
    logger.info(
      `Executing wave ${wave.wave}: ${wave.tasks.length} tasks` +
      (wave.canParallelize ? " (parallel)" : " (sequential)")
    );

    if (wave.canParallelize && wave.tasks.length > 1) {
      await this.executeParallel(wave.tasks, state, intelligence, markdownContent);
    } else {
      for (const task of wave.tasks) {
        await this.executeTask(task, state, intelligence, markdownContent);
      }
    }
  }

  private async acquireFileLock(file: string): Promise<() => void> {
    const existing = this.fileLocks.get(file) ?? Promise.resolve();
    let releaseFn!: () => void;
    const next = new Promise<void>((resolve) => { releaseFn = resolve; });
    this.fileLocks.set(file, existing.then(() => next));
    await existing;
    return releaseFn;
  }

  private async executeParallel(
    tasks: MigrationTask[],
    state: MigrationState,
    intelligence: CodebaseIntelligence | undefined,
    markdownContent: string | undefined
  ): Promise<void> {
    const fileTargets = new Set<string>();
    const serialTasks: MigrationTask[] = [];
    const parallelTasks: MigrationTask[] = [];

    for (const task of tasks) {
      const targetFiles = [task.file, ...(task.files ?? [])];
      const hasConflict = targetFiles.some((f) => fileTargets.has(f));
      if (hasConflict) {
        serialTasks.push(task);
      } else {
        parallelTasks.push(task);
        targetFiles.forEach((f) => fileTargets.add(f));
      }
    }

    const chunks: MigrationTask[][] = [];
    for (let i = 0; i < parallelTasks.length; i += MAX_PARALLEL) {
      chunks.push(parallelTasks.slice(i, i + MAX_PARALLEL));
    }

    for (const chunk of chunks) {
      await Promise.all(
        chunk.map((task) => this.executeTask(task, state, intelligence, markdownContent))
      );
    }

    for (const task of serialTasks) {
      await this.executeTask(task, state, intelligence, markdownContent);
    }
  }

  private async executeTask(
    task: MigrationTask,
    state: MigrationState,
    intelligence: CodebaseIntelligence | undefined,
    markdownContent: string | undefined
  ): Promise<void> {
    if (state.completedTasks.has(task.id)) return;

    logger.info(`Executing task ${task.id}: ${task.type ?? "code"} — ${task.file}`);

    const targetFiles = [task.file, ...(task.files ?? [])];
    const releases = await Promise.all(targetFiles.map((f) => this.acquireFileLock(f)));

    try {
      const ctx = this.buildTaskContext(task, state, markdownContent);
      const operation = await this.codingAgent.processTaskWithContext(task, ctx);

      applyFileOperation(state, operation);
      markTaskComplete(state, task.id);

      this.updateGlobalDecisionsFromOperation(state, operation);
    } catch (error) {
      const msg = (error as Error).message;
      logger.error(`Task ${task.id} failed: ${msg}`);
      markTaskFailed(state, task.id, msg);
    } finally {
      releases.forEach((release) => release());
    }
  }

  private buildTaskContext(
    task: MigrationTask,
    state: MigrationState,
    markdownContent: string | undefined
  ): TaskExecutionContext {
    const dependencyContents = this.collectDependencyContents(task, state);
    const guidance = markdownContent
      ? this.extractMarkdownGuidanceForTask(task, markdownContent)
      : undefined;

    return {
      state,
      dependencyContents,
      markdownGuidance: guidance,
    };
  }

  private collectDependencyContents(
    task: MigrationTask,
    state: MigrationState
  ): Map<string, string> {
    const deps = new Map<string, string>();

    for (const depId of task.dependsOn ?? []) {
      const depFiles = this.resolveTaskFiles(depId, state);
      for (const depFile of depFiles) {
        const content = state.fileMap.get(depFile);
        if (content && deps.size < 5) {
          deps.set(depFile, content);
        }
      }
    }

    return deps;
  }

  private resolveTaskFiles(taskId: string, state: MigrationState): string[] {
    for (const op of state.operations) {
      if ((op as any).taskId === taskId) {
        return [op.file];
      }
    }
    return [];
  }

  private extractMarkdownGuidanceForTask(task: MigrationTask, markdown: string): string {
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

  private inferGlobalDecisions(
    state: MigrationState,
    plan: MigrationPlan,
    intelligence: CodebaseIntelligence | undefined
  ): void {
    if (intelligence) {
      const firstController = intelligence.keyFiles.controllers[0];
      if (firstController) {
        const parts = firstController.split("/");
        const javaIndex = parts.indexOf("java");
        if (javaIndex !== -1) {
          state.globalDecisions.packageRoot = parts.slice(javaIndex + 1, -1).join(".");
        }
      }
    }

    for (const task of plan.tasks) {
      if (
        task.type === "build" &&
        (task.description.toLowerCase().includes("main") ||
          task.description.toLowerCase().includes("springbootapplication"))
      ) {
        const mainFile = (task.files ?? [task.file])[0];
        state.globalDecisions.mainClass = mainFile;
      }

      if (task.type === "config") {
        const configFiles = task.files ?? [task.file];
        state.globalDecisions.configClasses.push(...configFiles);
      }
    }

    logger.info(
      `Global decisions inferred: packageRoot="${state.globalDecisions.packageRoot}", mainClass="${state.globalDecisions.mainClass}"`
    );
  }

  private updateGlobalDecisionsFromOperation(
    state: MigrationState,
    operation: FileOperation
  ): void {
    if (!operation.content) return;

    const content = operation.content;

    const beanMatches = content.matchAll(/@Bean\s*\n[^@]*?\s+(\w+)\s*\(/g);
    for (const match of beanMatches) {
      registerBean(state, match[1], operation.file);
    }

    const serviceMatch = content.match(
      /@(?:Service|Repository|Component|Controller|RestController)\s*(?:\([^)]*\))?\s*(?:public\s+)?class\s+(\w+)/
    );
    if (serviceMatch) {
      const beanName =
        serviceMatch[1].charAt(0).toLowerCase() + serviceMatch[1].slice(1);
      registerBean(state, beanName, operation.file);
    }

    if (content.includes("@SpringBootApplication")) {
      state.globalDecisions.mainClass = operation.file;
    }

    if (content.includes("@Configuration")) {
      if (!state.globalDecisions.configClasses.includes(operation.file)) {
        state.globalDecisions.configClasses.push(operation.file);
      }
    }
  }

  private buildResult(state: MigrationState, _allTasks: MigrationTask[]): MigrationResult {
    let filesModified = 0;
    let filesCreated = 0;
    let filesDeleted = 0;

    for (const op of state.operations) {
      switch (op.action) {
        case "modify": filesModified++; break;
        case "create": filesCreated++; break;
        case "delete": filesDeleted++; break;
      }
    }

    const errors = state.errors.map((e) => `[${e.taskId}] ${e.error}`);
    const success = state.failedTasks.size === 0;

    if (state.failedTasks.size > 0) {
      logger.warn(
        `${state.failedTasks.size} tasks failed: ${Array.from(state.failedTasks.keys()).join(", ")}`
      );
    }

    return {
      filesModified,
      filesCreated,
      filesDeleted,
      operations: state.operations,
      success,
      errors,
    };
  }

  async applyRepairs(
    repairs: FileOperation[],
    currentFiles: Map<string, string>
  ): Promise<void> {
    logger.info(`Applying ${repairs.length} repair operations`);

    for (const repair of repairs) {
      if (repair.action === "delete") {
        currentFiles.delete(repair.file);
      } else if (repair.content) {
        currentFiles.set(repair.file, repair.content);
      }
      logger.info(`Applied repair: ${repair.action} ${repair.file}`);
    }
  }

  operationsToFileMap(operations: FileOperation[]): FileMap {
    const fileMap: FileMap = {};

    for (const op of operations) {
      if (op.action !== "delete" && op.content) {
        fileMap[op.file] = {
          type: "file",
          content: op.content,
          isBinary: false,
        } as any;
      }
    }

    return fileMap;
  }

  getDeletedFiles(operations: FileOperation[]): string[] {
    return operations
      .filter((op) => op.action === "delete")
      .map((op) => op.file);
  }
}

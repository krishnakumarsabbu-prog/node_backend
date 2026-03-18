import type { Response } from "express";
import { MigrationRunner } from "../migration/core/migrationRunner";
import {
  streamPlanResponse,
  parsePlanIntoSteps,
  type StreamWriter,
} from "../llm/plan-processor";
import type { MigrationPlan } from "../migration/types/migrationTypes";
import type { FileMap } from "../llm/constants";
import type { Messages, StreamingOptions } from "../llm/stream-text";
import type { ProgressAnnotation, ContextAnnotation } from "../types/context";
import { createScopedLogger } from "../utils/logger";

const logger = createScopedLogger("chat-migration");

export interface MigrationRequest {
  files: FileMap;
  messages: Messages;
  workDir: string;
  migrationAction?: "plan" | "implement";
  migrationPlan?: any;
  migrationDocument?: string;
}

export class ChatMigrationHandler {
  private runner: MigrationRunner;

  constructor(workDir: string, enableVerification = false) {
    this.runner = new MigrationRunner({
      workDir,
      enableVerification,
      enableAutoRepair: enableVerification,
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

    writeDataPart(res, {
      type: "progress",
      label: "migration",
      status: "in-progress",
      order: progressCounter++,
      message: "Analysing project structure...",
    } satisfies ProgressAnnotation);

    const userMessage = request.messages[request.messages.length - 1];
    const userRequest = typeof userMessage.content === "string" ? userMessage.content : "";

    try {
      writeDataPart(res, {
        type: "progress",
        label: "migration",
        status: "in-progress",
        order: progressCounter++,
        message: "Generating Migration.md plan document...",
      } satisfies ProgressAnnotation);

      const { markdownContent, plan } = await this.runner.generateMigrationDocument(
        request.files,
        userRequest,
      );

      writeDataPart(res, {
        type: "progress",
        label: "migration",
        status: "in-progress",
        order: progressCounter++,
        message: "Parsing migration steps...",
      } satisfies ProgressAnnotation);

      const migrationFileMap: FileMap = {
        ...request.files,
        "migration.md": {
          type: "file",
          content: markdownContent,
          isBinary: false,
        } as any,
      };

      const planStepsRaw = await parsePlanIntoSteps(markdownContent, migrationFileMap);

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
        type: "planSteps",
        steps: planStepsRaw.map((s) => ({ index: s.index, heading: s.heading })),
        totalSteps: planStepsRaw.length,
        executionMode: "files",
      });

      writeDataPart(res, {
        type: "progress",
        label: "migration",
        status: "complete",
        order: progressCounter++,
        message: `Migration plan ready: ${planStepsRaw.length} steps (${plan.estimatedComplexity || "medium"} complexity)`,
      } satisfies ProgressAnnotation);

      logger.info(`Migration.md plan generated: ${planStepsRaw.length} steps`);
    } catch (error) {
      logger.error(`Plan generation failed: ${(error as Error).message}`);

      writeDataPart(res, {
        type: "progress",
        label: "migration",
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

    if (!request.migrationPlan) {
      throw new Error("Migration plan is required for execution");
    }

    const plan: MigrationPlan = request.migrationPlan;
    const migrationDocument: string | undefined = request.migrationDocument;
    const tasks = plan.tasks || [];

    writeDataPart(res, {
      type: "progress",
      label: "migration-execute",
      status: "in-progress",
      order: progressCounter++,
      message: `Starting migration implementation: creating project under migrate/`,
    } satisfies ProgressAnnotation);

    if (apiKeys && streamingOptions) {
      const userRequest = this.extractUserRequest(request.messages);

      const migrationQuestion = this.buildMigrationQuestion(
        userRequest,
        plan,
        migrationDocument,
      );

      const planWriter: StreamWriter = {
        writeData: (data: unknown) => {
          writeDataPart(res, data);
          return true;
        },
        writeAnnotation: (ann: unknown) => {
          writeMessageAnnotationPart(res, ann);
          return true;
        },
        isAlive: () => !res.writableEnded && !res.destroyed,
      };

      const progressRef = { value: progressCounter };
      const cumulativeUsage = { completionTokens: 0, promptTokens: 0, totalTokens: 0 };

      const migrationFiles = this.buildMigrationFileMap(plan, request.files, migrationDocument);

      await streamPlanResponse({
        res,
        requestId: "migration-execute",
        messages: request.messages,
        files: migrationFiles,
        userQuestion: migrationQuestion,
        streamingOptions,
        apiKeys,
        providerSettings: providerSettings || {},
        promptId: "plan",
        chatMode: "build",
        progressCounter: progressRef,
        writer: planWriter,
        cumulativeUsage,
      });

      progressCounter = progressRef.value;

      writeMessageAnnotationPart(res, {
        type: "migration_result",
        result: {
          success: true,
          filesModified: tasks.filter((t) => t.action === "modify").length,
          filesCreated: tasks.filter((t) => t.action === "create").length,
          filesDeleted: tasks.filter((t) => t.action === "delete").length,
          errors: [],
        },
      } as ContextAnnotation);
    } else {
      const progressRef = { value: progressCounter };
      progressRef.value = await this.executeWithRunner(
        plan,
        request.files,
        writeDataPart,
        writeMessageAnnotationPart,
        res,
        progressRef.value,
      );
      progressCounter = progressRef.value;
    }

    return progressCounter;
  }

  private buildMigrationQuestion(
    userRequest: string,
    plan: MigrationPlan,
    migrationDocument?: string,
  ): string {
    const baseRequest = userRequest || "Migrate the project";

    if (migrationDocument) {
      return `${baseRequest}

You are implementing a migration. The NEW migrated project must be created inside the \`migrate/\` folder (i.e., all new files go under \`/home/project/migrate/\`).

DO NOT modify the original source files. Only create new files under migrate/.

Here is the detailed Migration.md plan — follow it step by step, implementing every file listed:

${migrationDocument}`;
    }

    const tasks = plan.tasks;

    return `${baseRequest}

Migration type: ${plan.migrationType}

You are implementing a migration. All new migrated files must be created inside the \`migrate/\` folder (i.e., all paths should start with \`migrate/\`).

DO NOT modify the original source files. Only create new files under migrate/.

Files to create:
${tasks.map((t) => `- ${t.file}: ${t.description}`).join("\n")}`;
  }

  private async executeWithRunner(
    plan: MigrationPlan,
    files: FileMap,
    writeDataPart: (res: Response, data: unknown) => void,
    writeMessageAnnotationPart: (res: Response, data: unknown) => void,
    res: Response,
    progressCounter: number,
  ): Promise<number> {
    const tasks = plan.tasks || [];

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];

      writeDataPart(res, {
        type: "progress",
        label: `migration-task-${i + 1}`,
        status: "in-progress",
        order: progressCounter++,
        message: `Step ${i + 1}/${tasks.length}: ${task.action} ${task.file}`,
      } satisfies ProgressAnnotation);

      writeDataPart(res, {
        type: "progress",
        label: `migration-task-${i + 1}`,
        status: "complete",
        order: progressCounter++,
        message: `Step ${i + 1}/${tasks.length} done: ${task.file}`,
      } satisfies ProgressAnnotation);
    }

    try {
      const result = await this.runner.executePlan(plan, files);

      const summary = result.success
        ? `Migration complete: ${result.filesModified} modified, ${result.filesCreated} created, ${result.filesDeleted} deleted`
        : `Migration completed with ${result.errors.length} error(s)`;

      writeDataPart(res, {
        type: "progress",
        label: "migration-execute",
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
        },
      } as ContextAnnotation);

      logger.info(
        `Execution complete: ${result.filesModified} modified, ${result.filesCreated} created, ${result.filesDeleted} deleted`,
      );
    } catch (error) {
      logger.error(`Execution failed: ${(error as Error).message}`);

      writeDataPart(res, {
        type: "progress",
        label: "migration-execute",
        status: "complete",
        order: progressCounter++,
        message: `Execution failed: ${(error as Error).message}`,
      } satisfies ProgressAnnotation);

      throw error;
    }

    return progressCounter;
  }

  private buildMigrationFileMap(
    plan: MigrationPlan,
    originalFiles: FileMap,
    migrationDocument?: string,
  ): FileMap {
    const result: FileMap = { ...originalFiles };

    if (migrationDocument) {
      result["migration.md"] = {
        type: "file",
        content: migrationDocument,
        isBinary: false,
      } as any;
    }

    for (const task of plan.tasks) {
      if (task.action === "create" && !result[task.file]) {
        result[task.file] = {
          type: "file",
          content: "",
          isBinary: false,
        } as any;
      }
    }

    return result;
  }

  private extractUserRequest(messages: Messages): string {
    const lastUser = [...messages].reverse().find((m: any) => m.role === "user");
    if (!lastUser) return "";
    if (typeof lastUser.content === "string") return lastUser.content;
    if (Array.isArray(lastUser.content)) {
      return (lastUser.content as any[])
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join(" ");
    }
    return "";
  }
}

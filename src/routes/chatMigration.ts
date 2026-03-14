import type { Response } from "express";
import { MigrationRunner } from "../migration/core/migrationRunner";
import type { MigrationContext } from "../migration/types/migrationTypes";
import type { FileMap } from "../llm/constants";
import type { Messages } from "../llm/stream-text";
import type { ProgressAnnotation, ContextAnnotation } from "../types/context";
import { createScopedLogger } from "../utils/logger";

const logger = createScopedLogger("chat-migration");

export interface MigrationRequest {
  files: FileMap;
  messages: Messages;
  workDir: string;
  migrationAction?: "plan" | "implement";
  migrationPlan?: any;
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
    progressCounter: number
  ): Promise<number> {
    logger.info("Handling migration plan generation");

    writeDataPart(res, {
      type: "progress",
      label: "migration",
      status: "in-progress",
      order: progressCounter++,
      message: "Analyzing project structure",
    } satisfies ProgressAnnotation);

    const userMessage = request.messages[request.messages.length - 1];
    const userRequest = typeof userMessage.content === "string" ? userMessage.content : "";

    try {
      const plan = await this.runner.generatePlanOnly(request.files, userRequest);

      writeDataPart(res, {
        type: "progress",
        label: "migration",
        status: "complete",
        order: progressCounter++,
        message: "Migration plan generated successfully",
      } satisfies ProgressAnnotation);

      writeMessageAnnotationPart(res, {
        type: "migration_plan",
        plan: {
          migrationType: plan.migrationType,
          summary: plan.summary,
          tasks: plan.tasks,
          estimatedComplexity: plan.estimatedComplexity,
        },
      } as ContextAnnotation);

      logger.info(`Plan generated: ${plan.tasks.length} tasks`);
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
    progressCounter: number
  ): Promise<number> {
    logger.info("Handling migration plan execution");

    if (!request.migrationPlan) {
      throw new Error("Migration plan is required for execution");
    }

    writeDataPart(res, {
      type: "progress",
      label: "migration",
      status: "in-progress",
      order: progressCounter++,
      message: "Executing migration tasks",
    } satisfies ProgressAnnotation);

    try {
      const result = await this.runner.executePlan(request.migrationPlan, request.files);

      if (result.success) {
        writeDataPart(res, {
          type: "progress",
          label: "migration",
          status: "complete",
          order: progressCounter++,
          message: "Migration completed successfully",
        } satisfies ProgressAnnotation);
      } else {
        writeDataPart(res, {
          type: "progress",
          label: "migration",
          status: "complete",
          order: progressCounter++,
          message: `Migration completed with ${result.errors.length} errors`,
        } satisfies ProgressAnnotation);
      }

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
        `Execution complete: ${result.filesModified} modified, ${result.filesCreated} created, ${result.filesDeleted} deleted`
      );
    } catch (error) {
      logger.error(`Execution failed: ${(error as Error).message}`);

      writeDataPart(res, {
        type: "progress",
        label: "migration",
        status: "complete",
        order: progressCounter++,
        message: `Execution failed: ${(error as Error).message}`,
      } satisfies ProgressAnnotation);

      throw error;
    }

    return progressCounter;
  }
}

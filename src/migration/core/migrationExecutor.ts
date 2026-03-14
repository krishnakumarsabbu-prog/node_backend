import type { MigrationPlan, MigrationResult, FileOperation } from "../types/migrationTypes";
import type { FileMap } from "../../llm/constants";
import { CodingAgent } from "../agents/codingAgent";
import { createScopedLogger } from "../../utils/logger";

const logger = createScopedLogger("migration-executor");

export class MigrationExecutor {
  constructor(private codingAgent: CodingAgent) {}

  async execute(plan: MigrationPlan, files: FileMap): Promise<MigrationResult> {
    logger.info(`Executing migration plan: ${plan.tasks.length} tasks`);

    const result: MigrationResult = {
      filesModified: 0,
      filesCreated: 0,
      filesDeleted: 0,
      operations: [],
      success: true,
      errors: [],
    };

    const sortedTasks = [...plan.tasks].sort((a, b) => {
      const priorityA = a.priority ?? 5;
      const priorityB = b.priority ?? 5;
      return priorityB - priorityA;
    });

    const fileContents = new Map<string, string>();
    for (const [path, file] of Object.entries(files)) {
      if (file && 'content' in file) {
        fileContents.set(path, file.content);
      }
    }

    for (const task of sortedTasks) {
      try {
        logger.info(`Executing task ${result.operations.length + 1}/${sortedTasks.length}: ${task.action} ${task.file}`);

        const currentContent = fileContents.get(task.file);
        const operation = await this.codingAgent.processTask(task, currentContent);

        this.applyOperation(operation, fileContents);
        result.operations.push(operation);

        switch (operation.action) {
          case "modify":
            result.filesModified++;
            break;
          case "create":
            result.filesCreated++;
            break;
          case "delete":
            result.filesDeleted++;
            break;
        }

        logger.info(`Task completed: ${task.action} ${task.file}`);
      } catch (error) {
        const errorMsg = `Failed to execute task for ${task.file}: ${(error as Error).message}`;
        logger.error(errorMsg);
        result.errors.push(errorMsg);
        result.success = false;
      }
    }

    logger.info(
      `Execution complete: ${result.filesModified} modified, ${result.filesCreated} created, ${result.filesDeleted} deleted, ${result.errors.length} errors`
    );

    return result;
  }

  private applyOperation(operation: FileOperation, fileContents: Map<string, string>): void {
    switch (operation.action) {
      case "modify":
      case "create":
        if (operation.content) {
          fileContents.set(operation.file, operation.content);
        }
        break;
      case "delete":
        fileContents.delete(operation.file);
        break;
    }
  }

  async applyRepairs(
    repairs: FileOperation[],
    currentFiles: Map<string, string>
  ): Promise<void> {
    logger.info(`Applying ${repairs.length} repair operations`);

    for (const repair of repairs) {
      this.applyOperation(repair, currentFiles);
      logger.info(`Applied repair: ${repair.action} ${repair.file}`);
    }
  }

  operationsToFileMap(operations: FileOperation[]): FileMap {
    const fileMap: FileMap = {};

    for (const op of operations) {
      if (op.action !== "delete" && op.content) {
        fileMap[op.file] = {
          type: 'file',
          content: op.content,
          isBinary: false,
        };
      }
    }

    return fileMap;
  }

  getDeletedFiles(operations: FileOperation[]): string[] {
    return operations.filter((op) => op.action === "delete").map((op) => op.file);
  }
}

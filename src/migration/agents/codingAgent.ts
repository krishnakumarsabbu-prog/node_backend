import type { MigrationTask, FileOperation } from "../types/migrationTypes";
import { LLMClient } from "../llm/llmClient";
import { PromptBuilder } from "../llm/promptBuilder";
import { createScopedLogger } from "../../utils/logger";

const logger = createScopedLogger("coding-agent");

export class CodingAgent {
  constructor(private llmClient: LLMClient) {}

  async processTask(
    task: MigrationTask,
    currentContent?: string
  ): Promise<FileOperation> {
    logger.info(`Processing task: ${task.action} ${task.file}`);

    if (task.action === "delete") {
      return {
        file: task.file,
        action: "delete",
        previousContent: currentContent,
      };
    }

    if (task.action === "create" || task.action === "modify") {
      const prompt = PromptBuilder.buildCodingPrompt(
        task.file,
        task.action,
        task.description,
        currentContent
      );

      const response = await this.llmClient.generateText(prompt, {
        maxRetries: 2,
        systemPrompt: "You are a senior software engineer. Generate clean, production-ready code.",
      });

      if (!response.success || !response.data) {
        throw new Error(`Failed to generate code for ${task.file}: ${response.error}`);
      }

      const content = this.cleanGeneratedCode(response.data);

      return {
        file: task.file,
        action: task.action,
        content,
        previousContent: currentContent,
      };
    }

    throw new Error(`Unsupported action: ${task.action}`);
  }

  private cleanGeneratedCode(code: string): string {
    let cleaned = code.trim();

    if (cleaned.startsWith("```")) {
      const lines = cleaned.split("\n");
      lines.shift();
      if (lines[lines.length - 1].trim() === "```") {
        lines.pop();
      }
      cleaned = lines.join("\n");
    }

    cleaned = cleaned.trim();

    return cleaned;
  }

  async batchProcessTasks(
    tasks: MigrationTask[],
    fileContents: Map<string, string>
  ): Promise<FileOperation[]> {
    logger.info(`Batch processing ${tasks.length} tasks`);

    const operations: FileOperation[] = [];

    for (const task of tasks) {
      try {
        const currentContent = fileContents.get(task.file);
        const operation = await this.processTask(task, currentContent);
        operations.push(operation);
      } catch (error) {
        logger.error(`Failed to process task for ${task.file}: ${(error as Error).message}`);
        throw error;
      }
    }

    logger.info(`Batch processing complete: ${operations.length} operations`);

    return operations;
  }
}

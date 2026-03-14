import type { RepairContext, RepairResult, FileOperation } from "../types/migrationTypes";
import { RepairResultSchema } from "../schemas/migrationSchema";
import { LLMClient } from "../llm/llmClient";
import { PromptBuilder } from "../llm/promptBuilder";
import { createScopedLogger } from "../../utils/logger";

const logger = createScopedLogger("repair-agent");

export class RepairAgent {
  constructor(private llmClient: LLMClient) {}

  async repair(context: RepairContext): Promise<RepairResult> {
    logger.info(`Repair attempt ${context.attemptNumber}/5 for ${context.buildErrors.length} errors`);

    if (context.buildErrors.length === 0) {
      return {
        success: true,
        fixes: [],
        reasoning: "No errors to repair",
      };
    }

    const prompt = PromptBuilder.buildRepairPrompt(
      context.buildErrors,
      context.affectedFiles,
      context.attemptNumber
    );

    const response = await this.llmClient.generateJSON<RepairResult>(
      prompt,
      (data) => {
        const validated = RepairResultSchema.parse(data) as RepairResult;
        return validated;
      },
      {
        maxRetries: 2,
        systemPrompt: "You are a senior engineer specialized in fixing build errors.",
      }
    );

    if (!response.success || !response.data) {
      logger.error(`Repair generation failed: ${response.error}`);
      return {
        success: false,
        fixes: [],
        reasoning: `Failed to generate repair: ${response.error}`,
      };
    }

    const result = response.data;

    logger.info(
      `Repair plan generated: ${result.fixes.length} fixes, reasoning: ${result.reasoning.substring(0, 100)}`
    );

    return result;
  }

  async repairWithContext(
    context: RepairContext,
    fileContents: Map<string, string>
  ): Promise<RepairResult> {
    const result = await this.repair(context);

    if (!result.success) {
      return result;
    }

    for (const fix of result.fixes) {
      if (fix.action === "modify" && !fileContents.has(fix.file)) {
        logger.warn(`Repair tries to modify non-existent file: ${fix.file}`);
      }
    }

    return result;
  }

  shouldContinueRepair(attemptNumber: number, previousErrors: number, currentErrors: number): boolean {
    if (attemptNumber >= 5) {
      logger.warn("Maximum repair attempts reached");
      return false;
    }

    if (currentErrors === 0) {
      logger.info("All errors resolved");
      return false;
    }

    if (currentErrors >= previousErrors) {
      logger.warn(`Repair did not reduce errors: ${previousErrors} -> ${currentErrors}`);
      return attemptNumber < 3;
    }

    logger.info(`Errors reduced: ${previousErrors} -> ${currentErrors}`);
    return true;
  }
}

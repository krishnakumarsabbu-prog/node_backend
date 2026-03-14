import type { ProjectAnalysis, MigrationPlan } from "../types/migrationTypes";
import type { FileMap } from "../../llm/constants";
import { MigrationPlanSchema } from "../schemas/migrationSchema";
import { LLMClient } from "../llm/llmClient";
import { PromptBuilder } from "../llm/promptBuilder";
import { createScopedLogger } from "../../utils/logger";

const logger = createScopedLogger("planner-agent");

export class PlannerAgent {
  constructor(private llmClient: LLMClient) {}

  async generatePlan(
    files: FileMap,
    analysis: ProjectAnalysis,
    userRequest: string
  ): Promise<MigrationPlan> {
    logger.info("Generating migration plan");

    const fileList = Object.keys(files);
    const prompt = PromptBuilder.buildPlanningPrompt(analysis, userRequest, fileList);

    const response = await this.llmClient.generateJSON<MigrationPlan>(
      prompt,
      (data) => {
        const validated = MigrationPlanSchema.parse(data) as MigrationPlan;
        return validated;
      },
      {
        maxRetries: 3,
        systemPrompt:
          "You are a senior software architect. Generate migration plans as valid JSON only.",
      }
    );

    if (!response.success || !response.data) {
      throw new Error(`Failed to generate migration plan: ${response.error}`);
    }

    const plan = response.data;

    this.validatePlanAgainstProject(plan, fileList);

    logger.info(
      `Plan generated: ${plan.tasks.length} tasks, type=${plan.migrationType}, complexity=${plan.estimatedComplexity}`
    );

    return plan;
  }

  private validatePlanAgainstProject(plan: MigrationPlan, existingFiles: string[]): void {
    const existingFilesSet = new Set(existingFiles);

    for (const task of plan.tasks) {
      if (task.action === "modify" && !existingFilesSet.has(task.file)) {
        logger.warn(`Task references non-existent file for modification: ${task.file}`);
      }

      if (task.action === "delete" && !existingFilesSet.has(task.file)) {
        logger.warn(`Task references non-existent file for deletion: ${task.file}`);
      }

      if (task.action === "create" && existingFilesSet.has(task.file)) {
        logger.warn(`Task tries to create file that already exists: ${task.file}`);
      }
    }

    const modifyCount = plan.tasks.filter((t) => t.action === "modify").length;
    const deleteCount = plan.tasks.filter((t) => t.action === "delete").length;
    const createCount = plan.tasks.filter((t) => t.action === "create").length;

    if (
      modifyCount !== plan.summary.filesToModify ||
      deleteCount !== plan.summary.filesToDelete ||
      createCount !== plan.summary.filesToCreate
    ) {
      logger.warn(
        `Plan summary mismatch: summary says ${plan.summary.filesToModify}/${plan.summary.filesToDelete}/${plan.summary.filesToCreate} but tasks are ${modifyCount}/${deleteCount}/${createCount}`
      );
    }
  }
}

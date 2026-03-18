import { generateText } from "ai";
import type { ProjectAnalysis, MigrationPlan } from "../types/migrationTypes";
import type { FileMap } from "../../llm/constants";
import { MigrationPlanSchema } from "../schemas/migrationSchema";
import { LLMClient } from "../llm/llmClient";
import { PromptBuilder } from "../llm/promptBuilder";
import { getTachyonModel } from "../../modules/llm/providers/tachyon";
import { createScopedLogger } from "../../utils/logger";

const logger = createScopedLogger("planner-agent");

export interface MigrationDocument {
  markdownContent: string;
  plan: MigrationPlan;
}

export class PlannerAgent {
  constructor(private llmClient: LLMClient) {}

  async generateMigrationDocument(
    files: FileMap,
    analysis: ProjectAnalysis,
    userRequest: string
  ): Promise<MigrationDocument> {
    logger.info("Generating Migration.md document");

    const fileList = Object.keys(files);

    const fileContents: Record<string, string> = {};
    for (const [path, entry] of Object.entries(files)) {
      if (
        entry &&
        entry.type === "file" &&
        !entry.isBinary &&
        typeof (entry as any).content === "string"
      ) {
        fileContents[path] = (entry as any).content as string;
      }
    }

    const prompt = PromptBuilder.buildMigrationDocumentPrompt(
      analysis,
      userRequest,
      fileList,
      fileContents
    );

    const result = await generateText({
      model: getTachyonModel(),
      messages: [{ role: "user", content: prompt }],
      maxTokens: 8192,
    });

    const markdownContent = result.text.trim();

    const plan = this.extractPlanFromDocument(markdownContent, fileList);

    logger.info(
      `Migration.md generated: ${markdownContent.length} chars, ${plan.tasks.length} inferred tasks`
    );

    return { markdownContent, plan };
  }

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

  private extractPlanFromDocument(markdownContent: string, existingFiles: string[]): MigrationPlan {
    const stepMatches = markdownContent.matchAll(/^##\s+Step\s+\d+[:\s]+(.+)$/gm);
    const steps = Array.from(stepMatches).map((m) => m[1].trim());

    const fileMatches = markdownContent.matchAll(/\*\*`(migrate\/[^`]+)`\*\*/g);
    const migrateFiles = Array.from(new Set(
      Array.from(fileMatches).map((m) => m[1])
    ));

    const typeMatch = markdownContent.match(/^#\s+Migration Plan[:\s]+(.+)$/m);
    const migrationType = typeMatch
      ? typeMatch[1].trim().replace(/\s+/g, "_").toLowerCase()
      : "project_migration";

    const tasks = migrateFiles.map((file) => ({
      file,
      action: "create" as const,
      description: `Create ${file} as part of the migration to the new project structure`,
      priority: 5,
    }));

    return {
      migrationType,
      summary: {
        filesToModify: 0,
        filesToDelete: 0,
        filesToCreate: tasks.length,
      },
      tasks,
      estimatedComplexity: tasks.length > 20 ? "high" : tasks.length > 8 ? "medium" : "low",
    };
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

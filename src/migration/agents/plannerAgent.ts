import { generateText } from "ai";
import type { ProjectAnalysis, MigrationPlan, MigrationTask, MigrationTaskCategory, MigrationAction } from "../types/migrationTypes";
import type { FileMap } from "../../llm/constants";
import { MigrationPlanSchema } from "../schemas/migrationSchema";
import { LLMClient } from "../llm/llmClient";
import { PromptBuilder } from "../llm/promptBuilder";
import { getTachyonModel } from "../../modules/llm/providers/tachyon";
import { buildCodebaseIntelligence, type CodebaseIntelligence } from "../intelligence/contextBuilder";
import { MigrationPlanVerifierAgent } from "./migrationPlanVerifierAgent";
import { createScopedLogger } from "../../utils/logger";

const MAX_VERIFY_FIX_ATTEMPTS = 2;
const MAX_CYCLE_RETRY_ATTEMPTS = 2;

const logger = createScopedLogger("planner-agent");

export interface MigrationDocument {
  markdownContent: string;
  plan: MigrationPlan;
}

interface DualOutputTask {
  id: string;
  title: string;
  type: MigrationTaskCategory;
  action?: "create" | "modify" | "delete";
  files: string[];
  dependsOn: string[];
  description: string;
}

interface DualOutputResponse {
  markdown: string;
  tasks: DualOutputTask[];
}

export class PlannerAgent {
  private verifier = new MigrationPlanVerifierAgent();

  constructor(private llmClient: LLMClient) {}

  async generateMigrationDocument(
    files: FileMap,
    analysis: ProjectAnalysis,
    userRequest: string,
  ): Promise<MigrationDocument> {
    logger.info("Building codebase intelligence for migration document generation");

    const intelligence = buildCodebaseIntelligence(files, analysis);

    logger.info(
      `Intelligence built: ${intelligence.fileSummaries.length} summaries, ` +
      `${intelligence.dependencyGraph.edges.length} dep edges, ` +
      `${intelligence.xmlConfigs.length} XML configs, ` +
      `patterns=[${intelligence.migrationPatterns.join(", ")}]`
    );

    const fileList = Object.keys(files);

    // --- Call 1: Generate markdown document only ---
    const mdPrompt = PromptBuilder.buildMarkdownOnlyPrompt(intelligence, userRequest);
    logger.info(`Markdown-only prompt: ${mdPrompt.length} chars`);

    const { text: mdText } = await generateText({
      model: getTachyonModel(),
      messages: [{ role: "user", content: mdPrompt }],
      maxTokens: 6144,
    });

    const markdownContent = mdText.trim();
    logger.info(`Migration.md generated: ${markdownContent.length} chars`);

    // --- Call 2: Generate tasks JSON only, referencing the markdown summary ---
    for (let cycleAttempt = 1; cycleAttempt <= MAX_CYCLE_RETRY_ATTEMPTS + 1; cycleAttempt++) {
      const cycleHint = cycleAttempt > 1
        ? `\n\nIMPORTANT: Previous attempt had circular dependencies. Ensure dependsOn is strictly forward-only — no cycles.`
        : "";

      const tasksPrompt = PromptBuilder.buildTasksOnlyPrompt(intelligence, userRequest, markdownContent) + cycleHint;
      logger.info(`Tasks-only prompt: ${tasksPrompt.length} chars (attempt ${cycleAttempt})`);

      const { text: tasksText } = await generateText({
        model: getTachyonModel(),
        messages: [{ role: "user", content: tasksPrompt }],
        maxTokens: 4096,
      });

      let plan: MigrationPlan;
      try {
        plan = this.parseTasksOutput(tasksText.trim(), fileList);
      } catch (parseErr: any) {
        if (parseErr.message?.startsWith("CYCLE_DETECTED") && cycleAttempt <= MAX_CYCLE_RETRY_ATTEMPTS) {
          logger.warn(`Cycle detected in tasks (attempt ${cycleAttempt}), retrying tasks call...`);
          continue;
        }
        throw parseErr;
      }

      logger.info(`Tasks generated: ${plan.tasks.length} tasks`);

      let fixed: { markdownContent: string; plan: MigrationPlan };
      try {
        fixed = await this.verifyAndFix(intelligence, markdownContent, plan);
      } catch (fixErr: any) {
        if (fixErr.message?.startsWith("CYCLE_DETECTED") && cycleAttempt <= MAX_CYCLE_RETRY_ATTEMPTS) {
          logger.warn(`Cycle detected after verify/fix (attempt ${cycleAttempt}), retrying tasks call...`);
          continue;
        }
        throw fixErr;
      }

      return { markdownContent: fixed.markdownContent, plan: fixed.plan };
    }

    throw new Error("Failed to generate a cycle-free migration plan after maximum retry attempts");
  }

  private async verifyAndFix(
    intelligence: CodebaseIntelligence,
    markdownContent: string,
    plan: MigrationPlan
  ): Promise<{ markdownContent: string; plan: MigrationPlan }> {
    let currentMarkdown = markdownContent;
    let currentPlan = plan;

    for (let attempt = 1; attempt <= MAX_VERIFY_FIX_ATTEMPTS; attempt++) {
      logger.info(`Running plan verification (attempt ${attempt}/${MAX_VERIFY_FIX_ATTEMPTS})`);

      const verification = await this.verifier.verify(intelligence, currentMarkdown, currentPlan);

      logger.info(
        `Verification: status=${verification.status}, ` +
        `completeness=${verification.scores.completeness}/10, ` +
        `correctness=${verification.scores.correctness}/10, ` +
        `executability=${verification.scores.executability}/10`
      );

      if (verification.status === "PASS") {
        logger.info("Verification passed — plan accepted");
        return { markdownContent: currentMarkdown, plan: currentPlan };
      }

      const totalIssues =
        verification.missingItems.length +
        verification.taskIssues.length +
        verification.dependencyIssues.length +
        verification.technicalIssues.length;

      logger.warn(
        `Verification FAILED: ${totalIssues} issues found. ` +
        `Running auto-fix pass ${attempt}/${MAX_VERIFY_FIX_ATTEMPTS}...`
      );

      if (attempt === MAX_VERIFY_FIX_ATTEMPTS) {
        logger.warn("Max fix attempts reached — using last generated plan");
        break;
      }

      const fixed = await this.verifier.fix(
        intelligence,
        currentMarkdown,
        currentPlan,
        verification
      );

      currentMarkdown = fixed.markdownContent;
      currentPlan = fixed.plan;

      logger.info(
        `Fix applied: ${currentMarkdown.length} chars markdown, ${currentPlan.tasks.length} tasks`
      );
    }

    return { markdownContent: currentMarkdown, plan: currentPlan };
  }

  async generatePlan(
    files: FileMap,
    analysis: ProjectAnalysis,
    userRequest: string
  ): Promise<MigrationPlan> {
    logger.info("Building codebase intelligence for plan generation");

    const intelligence = buildCodebaseIntelligence(files, analysis);

    const fileList = Object.keys(files);
    const prompt = PromptBuilder.buildPlanningPrompt(analysis, userRequest, fileList, intelligence);

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

  private parseTasksOutput(text: string, fileList: string[]): MigrationPlan {
    const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
    const rawJson = jsonMatch ? jsonMatch[1].trim() : text.trim();

    let rawTasks: DualOutputTask[];
    try {
      const parsed = JSON.parse(rawJson);
      rawTasks = Array.isArray(parsed) ? parsed : parsed.tasks ?? [];
    } catch (err: any) {
      logger.warn(`Failed to parse tasks JSON: ${err}. Falling back to empty task list.`);
      rawTasks = [];
    }

    const tasks = this.convertAndValidateTasks(rawTasks);

    return {
      migrationType: "spring-mvc-to-boot",
      summary: {
        filesToModify: 0,
        filesToDelete: 0,
        filesToCreate: tasks.filter((t) => t.action === "create").length,
      },
      tasks,
      estimatedComplexity: tasks.length > 20 ? "high" : tasks.length > 8 ? "medium" : "low",
    };
  }

  private parseDualOutput(text: string, fileList: string[]): { markdownContent: string; plan: MigrationPlan } {
    const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
    const rawJson = jsonMatch ? jsonMatch[1].trim() : text.trim();

    try {
      const parsed: DualOutputResponse = JSON.parse(rawJson);

      if (!parsed.markdown || !Array.isArray(parsed.tasks)) {
        throw new Error("Invalid dual-output structure: missing markdown or tasks");
      }

      const tasks = this.convertAndValidateTasks(parsed.tasks);

      const plan: MigrationPlan = {
        migrationType: this.extractMigrationTypeFromMarkdown(parsed.markdown),
        summary: {
          filesToModify: 0,
          filesToDelete: 0,
          filesToCreate: tasks.filter((t) => t.action === "create").length,
        },
        tasks,
        estimatedComplexity: tasks.length > 20 ? "high" : tasks.length > 8 ? "medium" : "low",
      };

      logger.info(`Parsed dual-output: ${parsed.markdown.length} chars markdown, ${tasks.length} tasks`);

      return { markdownContent: parsed.markdown, plan };
    } catch (err: any) {
      if (err?.message?.startsWith("CYCLE_DETECTED")) {
        throw err;
      }
      logger.warn(`Failed to parse dual-output JSON: ${err}. Falling back to markdown extraction.`);
      return this.fallbackExtract(text, fileList);
    }
  }

  private convertAndValidateTasks(dualTasks: DualOutputTask[]): MigrationTask[] {
    const idSet = new Set(dualTasks.map((t) => t.id));

    const validDependsOn = (deps: string[]): string[] => {
      return deps.filter((dep) => {
        if (!idSet.has(dep)) {
          logger.warn(`Task dependsOn references unknown task id: ${dep}`);
          return false;
        }
        return true;
      });
    };

    const tasks: MigrationTask[] = dualTasks.map((t, i) => {
      const primaryFile = t.files && t.files.length > 0 ? t.files[0] : `migrate/task-${t.id}`;
      return {
        id: t.id || `task-${String(i + 1).padStart(3, "0")}`,
        file: primaryFile,
        action: (t.action ?? "create") as MigrationAction,
        description: t.description || t.title,
        type: t.type,
        files: t.files || [],
        dependsOn: validDependsOn(t.dependsOn || []),
        priority: this.taskTypeToPriority(t.type),
      };
    });

    this.validateTaskGraph(tasks);

    return tasks;
  }

  private taskTypeToPriority(type: MigrationTaskCategory | undefined): number {
    switch (type) {
      case "build": return 10;
      case "config": return 7;
      case "code": return 5;
      case "resource": return 2;
      default: return 5;
    }
  }

  private validateTaskGraph(tasks: MigrationTask[]): void {
    const uniqueIds = new Set<string>();
    for (const task of tasks) {
      if (uniqueIds.has(task.id)) {
        logger.warn(`Duplicate task id detected: ${task.id}`);
      }
      uniqueIds.add(task.id);
    }

    const adjacency: Record<string, string[]> = {};
    for (const task of tasks) {
      adjacency[task.id] = task.dependsOn || [];
    }

    const visited = new Set<string>();
    const inStack = new Set<string>();
    let cycleNode: string | null = null;

    const hasCycle = (id: string): boolean => {
      if (inStack.has(id)) {
        cycleNode = id;
        return true;
      }
      if (visited.has(id)) return false;
      visited.add(id);
      inStack.add(id);
      for (const dep of adjacency[id] || []) {
        if (hasCycle(dep)) return true;
      }
      inStack.delete(id);
      return false;
    };

    for (const id of Object.keys(adjacency)) {
      if (hasCycle(id)) {
        const err = `Circular dependency detected in task graph at task: ${cycleNode}`;
        logger.warn(err);
        throw new Error(`CYCLE_DETECTED: ${err}`);
      }
    }
  }

  private extractMigrationTypeFromMarkdown(markdown: string): string {
    const typeMatch = markdown.match(/^#\s+Migration Plan[:\s]+(.+)$/m);
    return typeMatch
      ? typeMatch[1].trim().replace(/\s+/g, "_").toLowerCase()
      : "project_migration";
  }

  private fallbackExtract(text: string, fileList: string[]): { markdownContent: string; plan: MigrationPlan } {
    const markdownContent = text;
    const plan = this.extractPlanFromDocument(markdownContent, fileList);
    return { markdownContent, plan };
  }

  private extractPlanFromDocument(markdownContent: string, existingFiles: string[]): MigrationPlan {
    const fileMatches = markdownContent.matchAll(/\*\*`(migrate\/[^`]+)`\*\*/g);
    const migrateFiles = Array.from(new Set(
      Array.from(fileMatches).map((m) => m[1])
    ));

    const typeMatch = markdownContent.match(/^#\s+Migration Plan[:\s]+(.+)$/m);
    const migrationType = typeMatch
      ? typeMatch[1].trim().replace(/\s+/g, "_").toLowerCase()
      : "project_migration";

    const tasks: MigrationTask[] = migrateFiles.map((file, i) => ({
      id: `task-${String(i + 1).padStart(3, "0")}`,
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

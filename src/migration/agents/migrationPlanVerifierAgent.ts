import { generateText } from "ai";
import type { MigrationPlan } from "../types/migrationTypes";
import type { CodebaseIntelligence } from "../intelligence/contextBuilder";
import { PromptBuilder } from "../llm/promptBuilder";
import { getTachyonModel } from "../../modules/llm/providers/tachyon";
import { createScopedLogger } from "../../utils/logger";

const logger = createScopedLogger("migration-plan-verifier");

export type VerificationStatus = "PASS" | "FAIL";

export interface TaskIssue {
  taskId: string;
  issue: string;
}

export interface VerificationScores {
  completeness: number;
  correctness: number;
  executability: number;
}

export interface MigrationPlanVerificationResult {
  status: VerificationStatus;
  summary: string;
  scores: VerificationScores;
  missingItems: string[];
  taskIssues: TaskIssue[];
  dependencyIssues: string[];
  technicalIssues: string[];
  consistencyIssues: string[];
  risks: string[];
  improvements: string[];
}

export class MigrationPlanVerifierAgent {
  async verify(
    intelligence: CodebaseIntelligence,
    markdownContent: string,
    plan: MigrationPlan
  ): Promise<MigrationPlanVerificationResult> {
    logger.info("Starting migration plan verification");

    const systemPrompt = PromptBuilder.buildVerifierSystemPrompt();
    const userPrompt = PromptBuilder.buildMigrationVerificationPrompt(
      intelligence,
      markdownContent,
      plan
    );

    const result = await generateText({
      model: getTachyonModel(),
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      maxTokens: 4096,
    });

    const verification = this.parseVerificationResult(result.text.trim());

    logger.info(
      `Verification result: status=${verification.status}, ` +
      `completeness=${verification.scores.completeness}/10, ` +
      `correctness=${verification.scores.correctness}/10, ` +
      `executability=${verification.scores.executability}/10, ` +
      `missingItems=${verification.missingItems.length}, ` +
      `taskIssues=${verification.taskIssues.length}`
    );

    return verification;
  }

  async fix(
    intelligence: CodebaseIntelligence,
    markdownContent: string,
    plan: MigrationPlan,
    verificationResult: MigrationPlanVerificationResult
  ): Promise<{ markdownContent: string; plan: MigrationPlan }> {
    logger.info("Running auto-fix pass for failed verification");

    const userPrompt = PromptBuilder.buildMigrationFixPrompt(
      intelligence,
      markdownContent,
      plan,
      verificationResult
    );

    const result = await generateText({
      model: getTachyonModel(),
      messages: [{ role: "user", content: userPrompt }],
      maxTokens: 8192,
    });

    return this.parseDualOutputFix(result.text.trim(), markdownContent, plan);
  }

  private parseVerificationResult(text: string): MigrationPlanVerificationResult {
    const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
    const rawJson = jsonMatch ? jsonMatch[1].trim() : text.trim();

    try {
      const parsed = JSON.parse(rawJson) as MigrationPlanVerificationResult;

      return {
        status: parsed.status === "PASS" ? "PASS" : "FAIL",
        summary: parsed.summary || "No summary provided",
        scores: {
          completeness: this.clampScore(parsed.scores?.completeness),
          correctness: this.clampScore(parsed.scores?.correctness),
          executability: this.clampScore(parsed.scores?.executability),
        },
        missingItems: Array.isArray(parsed.missingItems) ? parsed.missingItems : [],
        taskIssues: Array.isArray(parsed.taskIssues) ? parsed.taskIssues : [],
        dependencyIssues: Array.isArray(parsed.dependencyIssues) ? parsed.dependencyIssues : [],
        technicalIssues: Array.isArray(parsed.technicalIssues) ? parsed.technicalIssues : [],
        consistencyIssues: Array.isArray(parsed.consistencyIssues) ? parsed.consistencyIssues : [],
        risks: Array.isArray(parsed.risks) ? parsed.risks : [],
        improvements: Array.isArray(parsed.improvements) ? parsed.improvements : [],
      };
    } catch (err) {
      logger.warn(`Failed to parse verification JSON: ${err}. Returning FAIL with raw text.`);
      return this.failedVerification(text);
    }
  }

  private parseDualOutputFix(
    text: string,
    originalMarkdown: string,
    originalPlan: MigrationPlan
  ): { markdownContent: string; plan: MigrationPlan } {
    const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
    const rawJson = jsonMatch ? jsonMatch[1].trim() : text.trim();

    try {
      const parsed = JSON.parse(rawJson) as { markdown: string; tasks: any[] };

      if (!parsed.markdown || !Array.isArray(parsed.tasks)) {
        throw new Error("Invalid fix output structure");
      }

      const updatedTasks = parsed.tasks.map((t: any, i: number) => ({
        id: t.id || `task-${String(i + 1).padStart(3, "0")}`,
        file: t.files?.[0] || `migrate/task-${t.id}`,
        action: "create" as const,
        description: t.description || t.title,
        type: t.type,
        files: t.files || [],
        dependsOn: t.dependsOn || [],
        priority: t.priority ?? 5,
      }));

      return {
        markdownContent: parsed.markdown,
        plan: {
          ...originalPlan,
          tasks: updatedTasks,
          summary: {
            filesToModify: 0,
            filesToDelete: 0,
            filesToCreate: updatedTasks.length,
          },
        },
      };
    } catch (err) {
      logger.warn(`Failed to parse fix output: ${err}. Returning original plan.`);
      return { markdownContent: originalMarkdown, plan: originalPlan };
    }
  }

  private clampScore(value: unknown): number {
    const n = typeof value === "number" ? value : 0;
    return Math.max(0, Math.min(10, Math.round(n)));
  }

  private failedVerification(rawText: string): MigrationPlanVerificationResult {
    return {
      status: "FAIL",
      summary: "Verification failed to parse structured output from LLM",
      scores: { completeness: 0, correctness: 0, executability: 0 },
      missingItems: ["Could not determine — raw response: " + rawText.slice(0, 200)],
      taskIssues: [],
      dependencyIssues: [],
      technicalIssues: [],
      consistencyIssues: [],
      risks: [],
      improvements: [],
    };
  }
}

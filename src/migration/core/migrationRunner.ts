import type {
  MigrationPlan,
  MigrationResult,
  MigrationContext,
  BuildValidationResult,
  RepairContext,
} from "../types/migrationTypes";
import type { FileMap } from "../../llm/constants";
import { AnalyzerAgent } from "../agents/analyzerAgent";
import { PlannerAgent } from "../agents/plannerAgent";
import { CodingAgent } from "../agents/codingAgent";
import { VerificationAgent } from "../agents/verificationAgent";
import { RepairAgent } from "../agents/repairAgent";
import { MigrationExecutor } from "./migrationExecutor";
import { LLMClient } from "../llm/llmClient";
import { buildCodebaseIntelligence, type CodebaseIntelligence } from "../intelligence/contextBuilder";
import { runStaticValidation, serializeStaticValidationResult } from "./staticValidator";
import { createScopedLogger } from "../../utils/logger";

const logger = createScopedLogger("migration-runner");

export interface MigrationRunnerConfig {
  workDir: string;
  enableVerification: boolean;
  enableAutoRepair: boolean;
  enableStaticValidation: boolean;
  maxRepairAttempts: number;
}

const DEFAULT_CONFIG: MigrationRunnerConfig = {
  workDir: "/tmp/migration",
  enableVerification: true,
  enableAutoRepair: true,
  enableStaticValidation: true,
  maxRepairAttempts: 5,
};

export class MigrationRunner {
  private analyzerAgent: AnalyzerAgent;
  private plannerAgent: PlannerAgent;
  private codingAgent: CodingAgent;
  private verificationAgent: VerificationAgent;
  private repairAgent: RepairAgent;
  private executor: MigrationExecutor;
  private config: MigrationRunnerConfig;

  constructor(config: Partial<MigrationRunnerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    const llmClient = new LLMClient();

    this.analyzerAgent = new AnalyzerAgent();
    this.plannerAgent = new PlannerAgent(llmClient);
    this.codingAgent = new CodingAgent(llmClient);
    this.verificationAgent = new VerificationAgent();
    this.repairAgent = new RepairAgent(llmClient);
    this.executor = new MigrationExecutor(this.codingAgent);

    logger.info("MigrationRunner initialized");
  }

  private snapshotFiles(files: FileMap): Map<string, string | null> {
    const snapshot = new Map<string, string | null>();
    for (const [path, file] of Object.entries(files)) {
      if (file && file.type === "file") {
        snapshot.set(path, (file as any).content ?? null);
      }
    }
    return snapshot;
  }

  private restoreSnapshot(files: FileMap, snapshot: Map<string, string | null>): void {
    for (const path of Object.keys(files)) {
      if (!snapshot.has(path)) {
        delete files[path];
      }
    }

    for (const [path, content] of snapshot.entries()) {
      if (content === null) {
        delete files[path];
      } else if (files[path]) {
        (files[path] as any).content = content;
      } else {
        files[path] = { type: "file", content, isBinary: false } as any;
      }
    }
    logger.info(`Rollback complete: restored ${snapshot.size} file(s) to pre-migration state`);
  }

  async executeMigration(context: MigrationContext): Promise<MigrationResult> {
    logger.info("Starting migration execution");

    const preSnapshot = this.snapshotFiles(context.files);

    try {
      const analysis = await this.analyzerAgent.analyze(context.files);
      logger.info("Project analysis complete");

      if (analysis.framework === "unknown") {
        logger.warn("Unknown framework detected — migration quality may be reduced");
      }
      if (analysis.buildTool === "unknown") {
        logger.warn("Unknown build tool detected — build verification will be skipped");
      }

      const intelligence = buildCodebaseIntelligence(context.files, analysis);
      logger.info(
        `Intelligence built: ${intelligence.fileSummaries.length} files, ` +
        `${intelligence.xmlConfigs.length} XML configs, ` +
        `patterns=[${intelligence.migrationPatterns.join(", ")}]`
      );

      const plan = await this.plannerAgent.generatePlan(
        context.files,
        analysis,
        context.userRequest
      );
      logger.info("Migration plan generated");

      const result = await this.executor.execute(plan, context.files, intelligence);
      logger.info("Migration execution complete");

      if (analysis.framework === "unknown") {
        result.frameworkWarning =
          "Framework could not be detected. Migration plan is based on generic patterns — review all generated files carefully.";
      }
      if (analysis.buildTool === "unknown") {
        result.frameworkWarning =
          (result.frameworkWarning ? result.frameworkWarning + " " : "") +
          "Build tool not detected — build verification was skipped.";
      }

      if (this.config.enableStaticValidation) {
        const migratedFiles = this.buildFileContentsMap(result);
        const staticResult = runStaticValidation(migratedFiles);
        const report = serializeStaticValidationResult(staticResult);
        logger.info(`Static validation:\n${report}`);

        if (!staticResult.passed) {
          logger.warn(`Static validation found ${staticResult.issues.filter((i) => i.severity === "error").length} errors`);
          result.errors.push(...staticResult.issues
            .filter((i) => i.severity === "error")
            .map((i) => `[static] ${i.message}`));
        }
      }

      if (!this.config.enableVerification || !result.success) {
        if (!result.success) {
          logger.warn("Migration execution failed, rolling back changes");
          this.restoreSnapshot(context.files, preSnapshot);
          result.rolledBack = true;
        }
        return result;
      }

      const validation = await this.verificationAgent.validate(
        analysis.buildTool,
        this.config.workDir
      );

      if (validation.success) {
        logger.info("Build validation passed");
        return result;
      }

      logger.warn(`Build validation failed with ${validation.errors.length} errors`);

      if (!this.config.enableAutoRepair) {
        logger.warn("Auto-repair disabled, rolling back migration");
        this.restoreSnapshot(context.files, preSnapshot);
        result.success = false;
        result.rolledBack = true;
        result.errors.push(...validation.errors.map((e) => e.message));
        return result;
      }

      const fileContents = this.buildFileContentsMap(result);
      const repairedResult = await this.repairLoop(
        result,
        validation,
        fileContents,
        analysis.buildTool
      );

      if (!repairedResult.success) {
        logger.warn("All repair attempts exhausted, rolling back migration");
        this.restoreSnapshot(context.files, preSnapshot);
        repairedResult.rolledBack = true;
      }

      return repairedResult;
    } catch (error) {
      logger.error(`Migration failed: ${(error as Error).message}`);
      logger.warn("Rolling back migration due to error");
      this.restoreSnapshot(context.files, preSnapshot);
      throw error;
    }
  }

  async generatePlanOnly(files: FileMap, userRequest: string): Promise<MigrationPlan> {
    logger.info("Generating migration plan only");

    const analysis = await this.analyzerAgent.analyze(files);
    const plan = await this.plannerAgent.generatePlan(files, analysis, userRequest);

    logger.info("Plan generation complete");
    return plan;
  }

  async generateMigrationDocument(
    files: FileMap,
    userRequest: string
  ): Promise<{ markdownContent: string; plan: MigrationPlan }> {
    logger.info("Generating Migration.md document");

    const analysis = await this.analyzerAgent.analyze(files);
    const doc = await this.plannerAgent.generateMigrationDocument(files, analysis, userRequest);

    logger.info("Migration.md generation complete");
    return doc;
  }

  async executePlan(
    plan: MigrationPlan,
    files: FileMap,
    intelligence?: CodebaseIntelligence,
    markdownContent?: string
  ): Promise<MigrationResult> {
    logger.info("Executing provided migration plan");

    const result = await this.executor.execute(plan, files, intelligence, markdownContent);

    if (this.config.enableStaticValidation) {
      const migratedFiles = this.buildFileContentsMap(result);
      const staticResult = runStaticValidation(migratedFiles);
      logger.info(`Static validation: ${staticResult.passed ? "PASSED" : "FAILED"} — ${staticResult.issues.length} issues`);

      if (!staticResult.passed) {
        result.errors.push(...staticResult.issues
          .filter((i) => i.severity === "error")
          .map((i) => `[static] ${i.message}`));
      }
    }

    if (!this.config.enableVerification || !result.success) {
      return result;
    }

    const analysis = await this.analyzerAgent.analyze(files);
    const fileContents = this.buildFileContentsMap(result);
    const validation = await this.verificationAgent.validate(
      analysis.buildTool,
      this.config.workDir
    );

    if (validation.success) {
      return result;
    }

    if (!this.config.enableAutoRepair) {
      result.success = false;
      result.errors.push(...validation.errors.map((e) => e.message));
      return result;
    }

    return this.repairLoop(result, validation, fileContents, analysis.buildTool);
  }

  private async repairLoop(
    initialResult: MigrationResult,
    initialValidation: BuildValidationResult,
    fileContents: Map<string, string>,
    buildTool: string
  ): Promise<MigrationResult> {
    logger.info("Starting repair loop");

    let currentResult = initialResult;
    let previousErrorCount = initialValidation.errors.length;
    let attemptNumber = 1;

    while (attemptNumber <= this.config.maxRepairAttempts) {
      logger.info(`Repair attempt ${attemptNumber}/${this.config.maxRepairAttempts}`);

      const validation = await this.verificationAgent.validate(
        buildTool as any,
        this.config.workDir
      );

      if (validation.success) {
        logger.info("Repair successful - build passed");
        currentResult.success = true;
        return currentResult;
      }

      const shouldContinue = this.repairAgent.shouldContinueRepair(
        attemptNumber,
        previousErrorCount,
        validation.errors.length
      );

      if (!shouldContinue) {
        logger.warn("Repair loop terminated");
        currentResult.success = false;
        currentResult.errors.push(...validation.errors.map((e) => e.message));
        return currentResult;
      }

      const repairContext: RepairContext = {
        buildErrors: validation.errors,
        recentOperations: currentResult.operations,
        affectedFiles: Array.from(fileContents.keys()),
        attemptNumber,
      };

      const repairResult = await this.repairAgent.repairWithContext(
        repairContext,
        fileContents
      );

      if (!repairResult.success || repairResult.fixes.length === 0) {
        logger.warn("Repair agent could not generate fixes");
        currentResult.success = false;
        currentResult.errors.push(...validation.errors.map((e) => e.message));
        return currentResult;
      }

      await this.executor.applyRepairs(repairResult.fixes, fileContents);
      currentResult.operations.push(...repairResult.fixes);

      previousErrorCount = validation.errors.length;
      attemptNumber++;
    }

    logger.warn("Maximum repair attempts reached");
    currentResult.success = false;
    return currentResult;
  }

  private buildFileContentsMap(result: MigrationResult): Map<string, string> {
    const map = new Map<string, string>();

    for (const op of result.operations) {
      if (op.action === "delete") {
        map.delete(op.file);
      } else if (op.content) {
        map.set(op.file, op.content);
      }
    }

    return map;
  }
}

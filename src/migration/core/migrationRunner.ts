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
import { createScopedLogger } from "../../utils/logger";

const logger = createScopedLogger("migration-runner");

export interface MigrationRunnerConfig {
  workDir: string;
  enableVerification: boolean;
  enableAutoRepair: boolean;
  maxRepairAttempts: number;
}

const DEFAULT_CONFIG: MigrationRunnerConfig = {
  workDir: "/tmp/migration",
  enableVerification: true,
  enableAutoRepair: true,
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

  async executeMigration(context: MigrationContext): Promise<MigrationResult> {
    logger.info("Starting migration execution");

    try {
      const analysis = await this.analyzerAgent.analyze(context.files);
      logger.info("Project analysis complete");

      const plan = await this.plannerAgent.generatePlan(
        context.files,
        analysis,
        context.userRequest
      );
      logger.info("Migration plan generated");

      const result = await this.executor.execute(plan, context.files);
      logger.info("Migration execution complete");

      if (!this.config.enableVerification || !result.success) {
        return result;
      }

      const fileContents = this.buildFileContentsMap(result);
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
        result.success = false;
        result.errors.push(...validation.errors.map((e) => e.message));
        return result;
      }

      const repairedResult = await this.repairLoop(
        result,
        validation,
        fileContents,
        analysis.buildTool
      );

      return repairedResult;
    } catch (error) {
      logger.error(`Migration failed: ${(error as Error).message}`);
      throw error;
    }
  }

  async generatePlanOnly(
    files: FileMap,
    userRequest: string
  ): Promise<MigrationPlan> {
    logger.info("Generating migration plan only");

    const analysis = await this.analyzerAgent.analyze(files);
    const plan = await this.plannerAgent.generatePlan(files, analysis, userRequest);

    logger.info("Plan generation complete");
    return plan;
  }

  async executePlan(plan: MigrationPlan, files: FileMap): Promise<MigrationResult> {
    logger.info("Executing provided migration plan");

    const result = await this.executor.execute(plan, files);

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

export type MigrationAction = "modify" | "delete" | "create";

export type BuildTool = "maven" | "gradle" | "npm" | "unknown";

export type Framework = "spring-mvc" | "spring-boot" | "express" | "django" | "unknown";

export interface MigrationTask {
  file: string;
  action: MigrationAction;
  description: string;
  priority?: number;
}

export interface MigrationSummary {
  filesToModify: number;
  filesToDelete: number;
  filesToCreate: number;
}

export interface MigrationPlan {
  migrationType: string;
  summary: MigrationSummary;
  tasks: MigrationTask[];
  estimatedComplexity?: "low" | "medium" | "high";
}

export interface ProjectAnalysis {
  framework: Framework;
  buildTool: BuildTool;
  xmlConfigs: string[];
  controllers: string[];
  services: string[];
  repositories: string[];
  configFiles: string[];
  dependencies: string[];
  entryPoints: string[];
  testFiles: string[];
}

export interface FileOperation {
  file: string;
  action: MigrationAction;
  content?: string;
  previousContent?: string;
}

export interface MigrationResult {
  filesModified: number;
  filesCreated: number;
  filesDeleted: number;
  operations: FileOperation[];
  success: boolean;
  errors: string[];
}

export interface BuildValidationResult {
  success: boolean;
  buildTool: BuildTool;
  errors: BuildError[];
  warnings: string[];
  logs: string;
  exitCode: number;
}

export interface BuildError {
  file?: string;
  line?: number;
  message: string;
  type: "compilation" | "dependency" | "configuration" | "unknown";
}

export interface RepairContext {
  buildErrors: BuildError[];
  recentOperations: FileOperation[];
  affectedFiles: string[];
  attemptNumber: number;
}

export interface RepairResult {
  success: boolean;
  fixes: FileOperation[];
  reasoning: string;
}

export interface MigrationContext {
  files: Record<string, any>;
  analysis?: ProjectAnalysis;
  userRequest: string;
  workDir: string;
  migrationAction?: "plan" | "implement";
  migrationPlan?: MigrationPlan;
}

export interface LLMResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  retries: number;
}

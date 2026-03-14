export type MigrationAction = "modify" | "delete" | "create";

export interface MigrationTask {
  file: string;
  action: MigrationAction;
  description: string;
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
}

export interface ProjectAnalysis {
  framework?: string;
  buildTool?: string;
  xmlConfigs?: string[];
  controllers?: string[];
  services?: string[];
  repositories?: string[];
  configFiles?: string[];
}

export interface MigrationResult {
  filesModified: number;
  filesCreated: number;
  filesDeleted: number;
  modifiedFiles: Record<string, string>;
  createdFiles: Record<string, string>;
  deletedFiles: string[];
}

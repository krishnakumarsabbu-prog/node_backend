export interface BatchFile {
  path: string;
  reason: string;
}

export interface BatchPlan {
  files: BatchFile[];
  totalSteps: number;
  userIntent: string;
}

export interface BatchStep {
  stepIndex: number;
  totalSteps: number;
  filePath: string;
  reason: string;
}

export interface BatchConfig {
  filesPerBatch: number;
}

export const DEFAULT_BATCH_CONFIG: BatchConfig = {
  filesPerBatch: 1,
};

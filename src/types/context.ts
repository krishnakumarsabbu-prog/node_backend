export type ContextAnnotation =
  | {
      type: 'codeContext';
      files: string[];
    }
  | {
      type: 'chatSummary';
      summary: string;
      chatId: string;
    }
  | {
      type: 'migration_plan';
      plan: any;
    }
  | {
      type: 'migration_result';
      result: any;
    }
  | {
      type: 'batchPlan';
      files: Array<{ stepIndex: number; filePath: string; reason: string }>;
      totalSteps: number;
      userIntent: string;
    };

export type ProgressAnnotation = {
  type: 'progress';
  label: string;
  status: 'in-progress' | 'complete';
  order: number;
  message: string;
};

export type ToolCallAnnotation = {
  type: 'toolCall';
  toolCallId: string;
  serverName: string;
  toolName: string;
  toolDescription: string;
};

export type AgentRunMetricsSummary = {
  totalRuns: number;
  recoveryTriggeredRuns: number;
  recoveredRuns: number;
  manualInterventionRuns: number;
  avgCommentaryFirstEventLatencyMs: number;
  recoverySuccessRate: number;
  manualInterventionRate: number;
};

export type AgentRunMetricsDataEvent = {
  type: 'run-metrics';
  runId: string;
  provider: string;
  model: string;
  commentaryFirstEventLatencyMs: number | null;
  recoveryTriggered: boolean;
  recoverySucceeded: boolean;
  manualIntervention: boolean;
  timestamp: string;
  aggregate: AgentRunMetricsSummary;
};

export type ProjectMemoryDataEvent = {
  type: 'project-memory';
  projectKey: string;
  summary: string;
  architecture: string;
  latestGoal: string;
  runCount: number;
  updatedAt: string;
};

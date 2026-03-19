import { createScopedLogger } from "../../utils/logger";
import type { PlanStep } from "../plan-processor";

const logger = createScopedLogger("sequential-executor");

export interface SequentialExecutionPlan {
  steps: PlanStep[];
  totalSteps: number;
}

export function buildSequentialExecutionPlan(steps: PlanStep[]): SequentialExecutionPlan {
  const sorted = [...steps].sort((a, b) => a.index - b.index);

  logger.info(
    `[sequential-executor] ${sorted.length} step(s) in strict dependency order`,
  );
  for (const s of sorted) {
    logger.info(`[sequential-executor]   step ${s.index}: ${s.heading}`);
  }

  return {
    steps: sorted,
    totalSteps: sorted.length,
  };
}

import { generateText } from "ai";
import { getTachyonModel } from "../../modules/llm/providers/tachyon";
import { createScopedLogger } from "../../utils/logger";
import type { PlanStep } from "../plan-processor";

const logger = createScopedLogger("parallel-planner");

export interface ParallelGroup {
  group: number;
  steps: number[];
  reason: string;
}

export interface ParallelExecutionPlan {
  groups: ParallelGroup[];
  totalGroups: number;
  parallelizable: boolean;
}

const PLANNER_SYSTEM = `
You are a software architect analyzing implementation steps for safe parallel execution.

Your job: group steps that can run IN PARALLEL (no data/file dependencies between them) into execution waves.

Return ONLY valid JSON — no prose, no markdown fences.

Schema:
{
  "groups": [
    { "group": 1, "steps": [1, 2], "reason": "Steps 1 and 2 create independent modules" },
    { "group": 2, "steps": [3], "reason": "Step 3 imports from steps 1 and 2" }
  ]
}

RULES FOR PARALLELIZATION:
1. Steps that share NO file dependencies can run in parallel
2. A step that imports from another step MUST run AFTER that step (different group)
3. Steps modifying the same file CANNOT be in the same group (sequential only)
4. Foundation steps (types, config, base utilities) must always be in group 1
5. Steps that extend/wire previous output always go in a later group
6. When in doubt, put steps in sequential groups (safety over parallelism)
7. Maximum 4 steps per parallel group to prevent context explosion
8. UI and API steps for the SAME feature must be in the same or adjacent groups

SAFE TO PARALLELIZE:
- Two independent features that share no files
- Multiple read-only utility modules with no shared state
- Sibling components with different routes

NEVER PARALLELIZE:
- Steps where one creates a type/service and another imports it
- Steps touching the same config, router, or entry point file
- Steps with explicit ordering requirements in their details
`;

export async function buildParallelExecutionPlan(
  steps: PlanStep[],
): Promise<ParallelExecutionPlan> {
  if (steps.length <= 2) {
    return {
      groups: steps.map((s, i) => ({ group: i + 1, steps: [s.index], reason: "Sequential (≤2 steps)" })),
      totalGroups: steps.length,
      parallelizable: false,
    };
  }

  const stepSummary = steps
    .map((s) => `Step ${s.index}: ${s.heading}\n  Details (first 300 chars): ${s.details.slice(0, 300)}`)
    .join("\n\n");

  try {
    const resp = await generateText({
      model: getTachyonModel(),
      system: PLANNER_SYSTEM,
      prompt: `
Analyze these ${steps.length} implementation steps and produce a parallel execution plan.

STEPS:
${stepSummary}

Group steps into execution waves. Steps in the same group run in parallel.
Return JSON only.
`,
    });

    const cleaned = resp.text.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "");
    const parsed = JSON.parse(cleaned);

    const groups: ParallelGroup[] = Array.isArray(parsed.groups) ? parsed.groups : [];

    const allGroupedIndices = new Set(groups.flatMap((g) => g.steps));
    for (const s of steps) {
      if (!allGroupedIndices.has(s.index)) {
        const lastGroup = groups[groups.length - 1];
        if (lastGroup) {
          lastGroup.steps.push(s.index);
        } else {
          groups.push({ group: 1, steps: [s.index], reason: "Fallback sequential" });
        }
      }
    }

    const hasParallelism = groups.some((g) => g.steps.length > 1);

    logger.info(
      `[parallel-planner] ${steps.length} steps → ${groups.length} groups (parallelizable=${hasParallelism})`,
    );
    for (const g of groups) {
      logger.info(`[parallel-planner]   Group ${g.group}: steps [${g.steps.join(", ")}] — ${g.reason}`);
    }

    return {
      groups,
      totalGroups: groups.length,
      parallelizable: hasParallelism,
    };
  } catch (err: any) {
    logger.warn(`[parallel-planner] Planning failed, falling back to sequential: ${err?.message}`);
    return {
      groups: steps.map((s, i) => ({
        group: i + 1,
        steps: [s.index],
        reason: "Sequential fallback",
      })),
      totalGroups: steps.length,
      parallelizable: false,
    };
  }
}

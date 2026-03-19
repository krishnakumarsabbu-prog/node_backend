import { generateText } from "ai";
import { getTachyonModel } from "../../modules/llm/providers/tachyon";
import { createScopedLogger } from "../../utils/logger";
import type { PlanStep } from "../plan-processor";

const logger = createScopedLogger("execution-scorer");

export interface ExecutionScore {
  score: number;
  breakdown: {
    completeness: number;
    integration: number;
    codeQuality: number;
    stateHandling: number;
    dependencyCorrectness: number;
  };
  passed: boolean;
  failReasons: string[];
  repairHints: string[];
}

const PASS_THRESHOLD = 65;

const SCORER_SYSTEM = `
You are a senior principal engineer scoring the output of an LLM code generation step.

Read the step specification and the generated output. Score the output on 5 dimensions (0-20 each = 100 total).

Return ONLY valid JSON — no prose, no markdown fences.

Schema:
{
  "completeness": number,
  "integration": number,
  "codeQuality": number,
  "stateHandling": number,
  "dependencyCorrectness": number,
  "failReasons": string[],
  "repairHints": string[]
}

SCORING RUBRIC:

completeness (0-20):
  20 = All files specified in the step are present, fully implemented, no stubs
  15 = Most files present, minor gaps
  10 = Some files missing or partially implemented
  5  = Many files missing or mostly stubs
  0  = Output is empty or entirely placeholder

integration (0-20):
  20 = Every new component is routed/imported/used; no orphan files
  15 = Most integrations present, one minor gap
  10 = Some wiring missing (e.g., route not added, sidebar not updated)
  5  = Major integration missing (component created but never used)
  0  = No integration at all — output is standalone with nothing connected

codeQuality (0-20):
  20 = TypeScript strict, no implicit any, proper error handling, SRP, <300 lines/file
  15 = Minor quality issues (missing return type, one implicit any)
  10 = Multiple quality issues but functional
  5  = Significant quality issues (no error handling, large files, bad patterns)
  0  = Non-compilable or completely broken code

stateHandling (0-20):
  20 = Loading, error, empty, success states all handled in UI
  15 = 3 of 4 states handled
  10 = 2 of 4 states handled
  5  = Only success state handled, no loading/error
  0  = No state handling at all (static content only)
  N/A = Step has no UI component (score full 20 automatically)

dependencyCorrectness (0-20):
  20 = All imported packages are in package.json, no phantom imports
  15 = One minor unregistered import
  10 = Multiple unregistered imports
  0  = Major dependency used without being declared

repairHints: concise list of specific things to fix (empty array if none)
failReasons: list of reasons the score is below threshold (empty array if passing)
`;

export async function scoreExecution(
  step: PlanStep,
  generatedOutput: string,
): Promise<ExecutionScore> {
  const outputSnippet = generatedOutput.slice(0, 8000);

  try {
    const resp = await generateText({
      model: getTachyonModel(),
      system: SCORER_SYSTEM,
      prompt: `
STEP SPECIFICATION:
Heading: ${step.heading}
Details:
${step.details}

GENERATED OUTPUT (truncated to 8000 chars):
${outputSnippet}

Score the output and return JSON.
`,
    });

    const cleaned = resp.text.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "");
    const parsed = JSON.parse(cleaned);

    const breakdown = {
      completeness: clamp(parsed.completeness ?? 0, 0, 20),
      integration: clamp(parsed.integration ?? 0, 0, 20),
      codeQuality: clamp(parsed.codeQuality ?? 0, 0, 20),
      stateHandling: clamp(parsed.stateHandling ?? 0, 0, 20),
      dependencyCorrectness: clamp(parsed.dependencyCorrectness ?? 0, 0, 20),
    };

    const score =
      breakdown.completeness +
      breakdown.integration +
      breakdown.codeQuality +
      breakdown.stateHandling +
      breakdown.dependencyCorrectness;

    const passed = score >= PASS_THRESHOLD;

    const result: ExecutionScore = {
      score,
      breakdown,
      passed,
      failReasons: Array.isArray(parsed.failReasons) ? parsed.failReasons : [],
      repairHints: Array.isArray(parsed.repairHints) ? parsed.repairHints : [],
    };

    logger.info(
      `[execution-scorer] Step ${step.index} score=${score}/100 (completeness=${breakdown.completeness} integration=${breakdown.integration} quality=${breakdown.codeQuality} states=${breakdown.stateHandling} deps=${breakdown.dependencyCorrectness}) passed=${passed}`,
    );

    if (!passed) {
      logger.warn(`[execution-scorer] Step ${step.index} BELOW THRESHOLD: ${result.failReasons.join("; ")}`);
    }

    return result;
  } catch (err: any) {
    logger.warn(`[execution-scorer] Scoring failed (non-fatal): ${err?.message}`);
    return {
      score: 100,
      breakdown: {
        completeness: 20,
        integration: 20,
        codeQuality: 20,
        stateHandling: 20,
        dependencyCorrectness: 20,
      },
      passed: true,
      failReasons: [],
      repairHints: [],
    };
  }
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export { PASS_THRESHOLD };

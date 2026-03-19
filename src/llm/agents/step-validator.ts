import { generateText } from "ai";
import { getTachyonModel } from "../../modules/llm/providers/tachyon";
import { createScopedLogger } from "../../utils/logger";
import type { PlanStep } from "../plan-processor";
import type { FileMap } from "../constants";

const logger = createScopedLogger("step-validator");

export interface StepValidationResult {
  valid: boolean;
  issues: string[];
  fixedStep?: PlanStep;
  deterministic: boolean;
}

const TRIVIAL_HEADING_PATTERNS = [
  /^create\s+\w+\s+file$/i,
  /^add\s+(import|export)s?$/i,
  /^update\s+imports?$/i,
  /^wire\s+up\s+\w+$/i,
  /^initialize\s+project$/i,
];

const SKELETON_DETAIL_PATTERNS = [
  /\/\/\s*TODO/i,
  /\/\/\s*FIXME/i,
  /\/\*\s*TODO/i,
  /throw new Error\(['"]not implemented['"]\)/i,
  /placeholder/i,
  /coming\s+soon/i,
];

const FORWARD_REF_PATTERNS = [
  /will be (created|implemented|added) in (a later|the next|step)/i,
  /to be implemented/i,
];

function runDeterministicChecks(
  step: PlanStep,
  steps: PlanStep[],
): { issues: string[]; hasCritical: boolean } {
  const issues: string[] = [];

  if (step.details.trim().length < 80) {
    issues.push("HEADER_ONLY: Step details are too short to describe a complete implementation");
  }

  if (TRIVIAL_HEADING_PATTERNS.some((re) => re.test(step.heading.trim()))) {
    issues.push("MICRO_STEP: Step heading describes an atomic task, not a feature-complete vertical slice");
  }

  for (const re of SKELETON_DETAIL_PATTERNS) {
    if (re.test(step.details)) {
      issues.push("SKELETON_CODE: Step details contain placeholder/TODO language");
      break;
    }
  }

  for (const re of FORWARD_REF_PATTERNS) {
    if (re.test(step.details)) {
      issues.push("FORWARD_REF: Step details reference code to be created later — reorder plan");
      break;
    }
  }

  const hasCritical = issues.some((i) => i.startsWith("FORWARD_REF"));
  return { issues, hasCritical };
}

const VALIDATOR_SYSTEM = `
You are a senior software architect validating an implementation step before it executes.

Only reject steps with genuine blockers that would cause broken or completely disconnected code.
Be lenient — imperfect steps should still run and be improved by the scorer.

Return ONLY valid JSON — no prose, no markdown fences.

Schema:
{
  "valid": boolean,
  "issues": string[],
  "fixedStep": { "heading": string, "details": string } | null
}

REJECTION RULES (only reject for these serious issues):
- ORPHAN_FILE: Creates a file that is never imported or used anywhere, no wiring instructions
- NO_INTEGRATION: Implements a UI feature but gives no path to connect it (no route, no nav, no import)
- MISSING_DEP: References a type/service from a previous step without importing it

AUTO-FIX: For ORPHAN_FILE, NO_INTEGRATION, MISSING_DEP — add the missing wiring/import to fixedStep details.
If you cannot fix it, set fixedStep to null.

If the step is reasonable (even if incomplete or imperfect), mark valid=true.
Do NOT reject for quality issues (too simple, no state handling, etc.) — the scorer handles those.
`;

export async function validateStep(
  step: PlanStep,
  allSteps: PlanStep[],
  accumulatedFiles: FileMap,
): Promise<StepValidationResult> {
  const { issues: deterministicIssues, hasCritical } = runDeterministicChecks(step, allSteps);

  if (hasCritical) {
    logger.warn(`[step-validator] Step ${step.index} FAILED deterministic (unfixable): ${deterministicIssues.join("; ")}`);
    return { valid: false, issues: deterministicIssues, deterministic: true };
  }

  if (deterministicIssues.length > 0) {
    logger.info(`[step-validator] Step ${step.index} has auto-fixable deterministic issues — enriching details`);
    const fixedDetails = step.details +
      `\n\nADDITIONAL REQUIREMENTS: Produce complete, non-stub implementations. Every component or service must be wired into the application entry point or router. All UI states (loading, error, empty, success) must be handled.`;
    return {
      valid: true,
      issues: deterministicIssues,
      fixedStep: { ...step, details: fixedDetails },
      deterministic: true,
    };
  }

  const existingFileList = Object.keys(accumulatedFiles)
    .filter((p) => accumulatedFiles[p]?.type === "file")
    .slice(0, 50)
    .map((p) => `  - ${p.replace("/home/project/", "")}`)
    .join("\n");

  const otherSteps = allSteps
    .filter((s) => s.index !== step.index)
    .map((s) => `  ${s.index}. ${s.heading}`)
    .join("\n");

  try {
    const resp = await generateText({
      model: getTachyonModel(),
      system: VALIDATOR_SYSTEM,
      prompt: `
STEP ${step.index}/${allSteps.length}:
Heading: ${step.heading}
Details:
${step.details.slice(0, 1200)}

ALL STEPS:
${otherSteps}

FILES IN PROJECT:
${existingFileList || "  (none yet)"}

Validate. Return JSON only.
`,
    });

    const cleaned = resp.text.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "");
    const parsed = JSON.parse(cleaned);

    const valid: boolean = parsed.valid !== false;
    const issues: string[] = Array.isArray(parsed.issues) ? parsed.issues : [];

    let fixedStep: PlanStep | undefined;
    if (!valid && parsed.fixedStep && typeof parsed.fixedStep?.details === "string") {
      fixedStep = {
        index: step.index,
        heading: typeof parsed.fixedStep.heading === "string" ? parsed.fixedStep.heading : step.heading,
        details: parsed.fixedStep.details,
      };
    }

    if (valid) {
      logger.info(`[step-validator] Step ${step.index} PASSED validation (LLM)`);
    } else {
      logger.warn(`[step-validator] Step ${step.index} FAILED (LLM): ${issues.join("; ")}`);
      if (fixedStep) logger.info(`[step-validator] Step ${step.index} AUTO-FIXED by LLM`);
    }

    return { valid, issues, fixedStep, deterministic: false };
  } catch (err: any) {
    logger.warn(`[step-validator] LLM validation failed (non-fatal): ${err?.message}`);
    return { valid: true, issues: [], deterministic: false };
  }
}

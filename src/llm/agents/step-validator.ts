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
}

const VALIDATION_SYSTEM = `
You are a senior software architect performing strict validation of an implementation step before execution.

Your job: evaluate the step against the rules below and return a JSON object.

Return ONLY valid JSON — no prose, no markdown fences.

Schema:
{
  "valid": boolean,
  "issues": string[],
  "fixedHeading": string | null,
  "fixedDetails": string | null
}

If the step is valid: { "valid": true, "issues": [], "fixedHeading": null, "fixedDetails": null }
If invalid but fixable: set "valid": false, populate "issues", provide corrected "fixedHeading" and "fixedDetails"
If too broken to fix: set "valid": false, populate "issues", set fixedHeading/fixedDetails to null

REJECTION RULES — reject if ANY of these are true:
1. MICRO-STEP: The step only creates a single file with no logic, adds boilerplate, or stubs a method
2. PARTIAL_IMPL: The step creates a service/hook/component but does NOT wire it to any consumer
3. ORPHAN_FILE: The step produces a file that nothing imports or routes to
4. FORWARD_REF: The step references a file, type, or API that does not exist yet in the known file list
5. NO_INTEGRATION: The step creates UI but does not specify where it connects (route, nav item, sidebar)
6. MISSING_DEP: The step uses a library not present in the project without updating package.json
7. HEADER_ONLY_UI: The step produces a page that only renders static content with no data fetching or interaction
8. INCOMPLETE_STATES: A UI step does not handle loading, error, and empty states
9. SKELETON_CODE: The details describe creating stub methods, TODOs, or placeholder implementations
10. FRAGMENTED: The step is one of several micro-steps implementing a single feature (e.g. "Wire X" after "Create X")

AUTO-FIX RULES:
- If the step has wiring issues (rule 2, 3, 5): expand the details to include integration
- If fragmented (rule 10): merge the context into one cohesive step description
- If missing dep declaration (rule 6): add package.json update to the details
- If UI states missing (rule 8): add state handling requirements to the details
- Do NOT fix FORWARD_REF (rule 4) — the planner must reorder steps
`;

export async function validateStep(
  step: PlanStep,
  allSteps: PlanStep[],
  accumulatedFiles: FileMap,
): Promise<StepValidationResult> {
  const filePaths = Object.keys(accumulatedFiles)
    .map((p) => p.replace("/home/project/", ""))
    .join("\n");

  const otherSteps = allSteps
    .filter((s) => s.index !== step.index)
    .map((s) => `  ${s.index}. ${s.heading}`)
    .join("\n");

  try {
    const resp = await generateText({
      model: getTachyonModel(),
      system: VALIDATION_SYSTEM,
      prompt: `
STEP TO VALIDATE:
Index: ${step.index}
Heading: ${step.heading}
Details:
${step.details}

ALL STEPS IN PLAN:
${otherSteps}

FILES ALREADY IN PROJECT:
${filePaths || "(none yet)"}

Validate the step and return JSON.
`,
    });

    const cleaned = resp.text.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "");
    const parsed = JSON.parse(cleaned);

    const result: StepValidationResult = {
      valid: parsed.valid === true,
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
    };

    if (!result.valid && parsed.fixedHeading && parsed.fixedDetails) {
      result.fixedStep = {
        index: step.index,
        heading: parsed.fixedHeading,
        details: parsed.fixedDetails,
      };
    }

    if (result.valid) {
      logger.info(`[step-validator] Step ${step.index} PASSED validation`);
    } else {
      logger.warn(`[step-validator] Step ${step.index} FAILED: ${result.issues.join("; ")}`);
      if (result.fixedStep) {
        logger.info(`[step-validator] Step ${step.index} AUTO-FIXED`);
      }
    }

    return result;
  } catch (err: any) {
    logger.warn(`[step-validator] Validation failed (non-fatal): ${err?.message}`);
    return { valid: true, issues: [] };
  }
}

import { generateText } from "ai";
import { getTachyonModel } from "../../modules/llm/providers/tachyon";
import { createScopedLogger } from "../../utils/logger";
import type { PlanStep } from "../plan-processor";
import type { ExecutionScore } from "./execution-scorer";

const logger = createScopedLogger("self-healing-loop");

export const SELF_HEAL_MAX_ATTEMPTS = 2;

export interface HealedStep {
  repairedStep: PlanStep;
  repairReason: string;
}

const HEAL_SYSTEM = `
You are a senior software engineer performing targeted repair of an implementation step that scored below the quality threshold.

You will receive:
1. The original step specification
2. The generated output that FAILED scoring
3. Specific failure reasons and repair hints from the scorer

Your job: produce a REPAIRED version of the step specification (heading + details) that explicitly addresses every failure reason.

Return ONLY valid JSON — no prose, no markdown fences.

Schema:
{
  "repairedHeading": string,
  "repairedDetails": string,
  "repairReason": string
}

REPAIR RULES:
- Address every failReason explicitly in the repairedDetails
- For INTEGRATION failures: add explicit wiring instructions (which file to import from, which route to register, which nav item to add)
- For COMPLETENESS failures: list every file that must be implemented in full
- For STATE_HANDLING failures: explicitly require loading, error, empty, success states
- For DEPENDENCY failures: add explicit "update package.json with X" instructions
- For CODE_QUALITY failures: add explicit quality requirements
- Keep the heading focused and action-oriented
- The repaired details must be MORE specific and prescriptive than the original
- Do NOT reduce scope — only add clarity and requirements
`;

export async function repairStep(
  step: PlanStep,
  failedOutput: string,
  score: ExecutionScore,
): Promise<HealedStep> {
  const outputSnippet = failedOutput.slice(0, 4000);
  const failureContext = [
    `Score: ${score.score}/100`,
    `Fail reasons: ${score.failReasons.join("; ")}`,
    `Repair hints: ${score.repairHints.join("; ")}`,
    `Breakdown: completeness=${score.breakdown.completeness} integration=${score.breakdown.integration} quality=${score.breakdown.codeQuality} states=${score.breakdown.stateHandling} deps=${score.breakdown.dependencyCorrectness}`,
  ].join("\n");

  try {
    const resp = await generateText({
      model: getTachyonModel(),
      system: HEAL_SYSTEM,
      prompt: `
ORIGINAL STEP:
Heading: ${step.heading}
Details:
${step.details}

FAILED OUTPUT (first 4000 chars):
${outputSnippet}

FAILURE ANALYSIS:
${failureContext}

Produce a repaired step specification that fixes all the issues above.
Return JSON only.
`,
    });

    const cleaned = resp.text.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "");
    const parsed = JSON.parse(cleaned);

    const repairedStep: PlanStep = {
      index: step.index,
      heading:
        typeof parsed.repairedHeading === "string" && parsed.repairedHeading.trim()
          ? parsed.repairedHeading
          : step.heading,
      details:
        typeof parsed.repairedDetails === "string" && parsed.repairedDetails.trim()
          ? parsed.repairedDetails
          : step.details,
    };

    const repairReason =
      typeof parsed.repairReason === "string" ? parsed.repairReason : "Auto-repaired based on scorer feedback";

    logger.info(`[self-healing-loop] Step ${step.index} repaired: ${repairReason}`);

    return { repairedStep, repairReason };
  } catch (err: any) {
    logger.warn(`[self-healing-loop] Repair failed (non-fatal): ${err?.message}`);
    const fallbackDetails = buildFallbackRepair(step, score);
    return {
      repairedStep: { ...step, details: fallbackDetails },
      repairReason: "Fallback repair: appended explicit requirements from scorer",
    };
  }
}

function buildFallbackRepair(step: PlanStep, score: ExecutionScore): string {
  const additions: string[] = [];

  if (score.breakdown.completeness < 15) {
    additions.push(
      "COMPLETENESS REQUIREMENT: Every file listed in this step MUST be fully implemented — no stubs, no TODOs, no empty methods.",
    );
  }

  if (score.breakdown.integration < 15) {
    additions.push(
      "INTEGRATION REQUIREMENT: Every new component, service, and API route MUST be wired into the application. Update the router, sidebar navigation, and any layout files that reference this feature.",
    );
  }

  if (score.breakdown.stateHandling < 15) {
    additions.push(
      "STATE HANDLING REQUIREMENT: All UI components MUST handle loading (spinner/skeleton), error (user-friendly message + retry), empty (meaningful empty state), and success states.",
    );
  }

  if (score.breakdown.dependencyCorrectness < 15) {
    additions.push(
      "DEPENDENCY REQUIREMENT: Before using any npm package, verify it is in package.json. If not, add it. Never import from an undeclared package.",
    );
  }

  if (score.repairHints.length > 0) {
    additions.push("SPECIFIC FIXES REQUIRED:");
    for (const hint of score.repairHints) {
      additions.push(`  - ${hint}`);
    }
  }

  if (additions.length === 0) return step.details;

  return `${step.details}\n\n---\nADDITIONAL REQUIREMENTS (from quality review):\n${additions.join("\n")}`;
}

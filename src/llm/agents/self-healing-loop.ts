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
  freshStart: boolean;
}

const REPAIR_SYSTEM = `
You are a senior software engineer repairing an implementation step that failed quality checks.

You will receive:
1. The original step specification
2. The failed output (for reference — do not blindly continue from it)
3. Specific failure reasons and repair hints

Your job: produce a REPAIRED step specification (heading + details) that explicitly addresses every failure reason.

Return ONLY valid JSON — no prose, no markdown fences.

Schema:
{
  "repairedHeading": string,
  "repairedDetails": string,
  "repairReason": string
}

REPAIR RULES:
- Address every failReason directly in the repairedDetails
- For NO_FILES: add "Output EVERY file using <cortexAction type=\\"file\\" filePath=\\"..\\"> blocks"
- For PLACEHOLDER_CODE: add "ZERO placeholder content — every method must be fully implemented"
- For NO_IMPORTS: add "Include proper import/export statements in every file"
- For NO_INTEGRATION / SYNTAX_RED: add explicit, targeted instructions
- Make repairedDetails MORE specific than the original — never less
- Do NOT reduce scope
`;

const FRESH_START_SYSTEM = `
You are a senior software engineer implementing a feature step from scratch.

A previous attempt was discarded due to fundamental failures. Do NOT reference or continue from it.
Produce a CORRECTED step specification that explicitly requires complete, working output.

Return ONLY valid JSON — no prose, no markdown fences.

Schema:
{
  "repairedHeading": string,
  "repairedDetails": string,
  "repairReason": string
}

REQUIREMENTS:
- State explicitly: "Output ALL files with complete implementations — no stubs, no TODOs"
- State explicitly: "Every file MUST use <cortexAction type=\\"file\\" filePath=\\"..\\"> blocks"
- State explicitly: "All imports and exports must be properly declared"
- For UI steps: "Wire the component into the router and navigation"
- Address every listed failure reason
- Be more prescriptive and detailed than the original
`;

export async function repairStep(
  step: PlanStep,
  failedOutput: string,
  score: ExecutionScore,
  attemptNumber: number,
): Promise<HealedStep> {
  const freshStart = attemptNumber >= 2;
  const system = freshStart ? FRESH_START_SYSTEM : REPAIR_SYSTEM;

  const failureContext = [
    `Score: ${score.score}/100`,
    `Fail reasons: ${score.failReasons.join("; ")}`,
    `Repair hints: ${score.repairHints.join("; ")}`,
  ].join("\n");

  const outputSection = freshStart
    ? ``
    : `\nFAILED OUTPUT (first 3000 chars — reference only, do not continue from it):\n${failedOutput.slice(0, 3000)}`;

  try {
    const resp = await generateText({
      model: getTachyonModel(),
      system,
      prompt: `
ORIGINAL STEP:
Heading: ${step.heading}
Details:
${step.details}
${outputSection}

FAILURE ANALYSIS:
${failureContext}

${freshStart ? "Produce a fresh complete step specification." : "Produce a repaired step specification."}
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
          : buildFallbackRepair(step, score, freshStart),
    };

    const repairReason =
      typeof parsed.repairReason === "string"
        ? parsed.repairReason
        : freshStart
          ? "Fresh start: discarded previous output, reimplementing from scratch"
          : "Auto-repaired based on scorer feedback";

    logger.info(`[self-healing-loop] Step ${step.index} repaired (freshStart=${freshStart}): ${repairReason}`);

    return { repairedStep, repairReason, freshStart };
  } catch (err: any) {
    logger.warn(`[self-healing-loop] Repair LLM failed (non-fatal): ${err?.message}`);
    const fallbackDetails = buildFallbackRepair(step, score, freshStart);
    return {
      repairedStep: { ...step, details: fallbackDetails },
      repairReason: freshStart
        ? "Fallback fresh-start: stripped previous output, added explicit requirements"
        : "Fallback repair: appended explicit requirements from scorer",
      freshStart,
    };
  }
}

function buildFallbackRepair(step: PlanStep, score: ExecutionScore, freshStart: boolean): string {
  const additions: string[] = [];

  if (freshStart) {
    additions.push(
      "CRITICAL: This is a fresh re-implementation. Do NOT reference or continue from any previous attempt.",
    );
  }

  additions.push(
    'OUTPUT REQUIREMENT: Every file MUST be output using <cortexAction type="file" filePath="..."> blocks.',
  );

  if (score.failReasons.some((r) => r.startsWith("NO_FILES"))) {
    additions.push("COMPLETENESS: Output ALL files this step creates or modifies as complete file blocks.");
  }

  if (score.failReasons.some((r) => r.startsWith("PLACEHOLDER_CODE"))) {
    additions.push(
      "IMPLEMENTATION: ZERO placeholder content. Every function and method must have a complete working implementation.",
    );
  }

  if (score.failReasons.some((r) => r.startsWith("NO_IMPORTS"))) {
    additions.push("IMPORTS: Every file must include proper TypeScript import and export statements.");
  }

  if (score.failReasons.some((r) => r.startsWith("SYNTAX_RED"))) {
    additions.push("SYNTAX: Ensure all code blocks are properly closed. Do not truncate any file.");
  }

  if (score.repairHints.length > 0) {
    additions.push("SPECIFIC FIXES REQUIRED:");
    for (const hint of score.repairHints) {
      additions.push(`  - ${hint}`);
    }
  }

  const baseDetails = freshStart
    ? step.details.split("\n\n---\nADDITIONAL REQUIREMENTS")[0]
    : step.details;

  return `${baseDetails}\n\n---\nADDITIONAL REQUIREMENTS (from quality review):\n${additions.join("\n")}`;
}

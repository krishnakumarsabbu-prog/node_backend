import { generateText } from "ai";
import { getTachyonModel } from "../../modules/llm/providers/tachyon";
import { createScopedLogger } from "../../utils/logger";
import type { PlanStep } from "../plan-processor";
import type { FileMap } from "../constants";

const logger = createScopedLogger("dependency-injector");

export interface DependencyInjectionResult {
  enrichedStep: PlanStep;
  missingDeps: string[];
  injected: boolean;
}

const INJECTION_SYSTEM = `
You are a dependency analysis expert. Your job: read an implementation step and determine if it references any npm packages that are NOT in the current package.json.

Return ONLY valid JSON — no prose, no markdown fences.

Schema:
{
  "missingDeps": string[],
  "enrichedDetails": string
}

- "missingDeps": array of npm package names that the step uses but are NOT in the provided package.json dependencies/devDependencies
- "enrichedDetails": the original step details, but with an explicit "Update package.json" instruction injected if any packages are missing. If no packages are missing, return the original details unchanged.

RULES:
- Only flag packages that are actually imported/used in the step's code — not hypothetical ones
- Standard library modules (node:fs, node:path, etc.) and built-in browser APIs are NOT missing deps
- React, ReactDOM, and framework packages already in the project should NOT be flagged
- If you add package.json update instructions, format them as: "Update package.json: add <packages> to dependencies"
- Do NOT rewrite the step — only prepend or append the package.json update instruction
`;

export async function injectMissingDependencies(
  step: PlanStep,
  packageJsonContent: string,
): Promise<DependencyInjectionResult> {
  try {
    const resp = await generateText({
      model: getTachyonModel(),
      system: INJECTION_SYSTEM,
      prompt: `
STEP:
Heading: ${step.heading}
Details:
${step.details}

CURRENT package.json:
${packageJsonContent}

Identify missing npm dependencies and return enriched details.
`,
    });

    const cleaned = resp.text.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "");
    const parsed = JSON.parse(cleaned);

    const missingDeps: string[] = Array.isArray(parsed.missingDeps) ? parsed.missingDeps : [];
    const enrichedDetails: string =
      typeof parsed.enrichedDetails === "string" ? parsed.enrichedDetails : step.details;

    if (missingDeps.length > 0) {
      logger.info(`[dependency-injector] Step ${step.index} missing deps: ${missingDeps.join(", ")}`);
    }

    return {
      enrichedStep: {
        ...step,
        details: enrichedDetails,
      },
      missingDeps,
      injected: missingDeps.length > 0,
    };
  } catch (err: any) {
    logger.warn(`[dependency-injector] Analysis failed (non-fatal): ${err?.message}`);
    return { enrichedStep: step, missingDeps: [], injected: false };
  }
}

export function extractPackageJson(files: FileMap): string {
  const key = Object.keys(files).find(
    (p) => p.endsWith("/package.json") || p === "package.json",
  );
  if (!key) return "{}";
  const entry = files[key];
  if (entry && entry.type === "file" && typeof entry.content === "string") {
    return entry.content;
  }
  return "{}";
}

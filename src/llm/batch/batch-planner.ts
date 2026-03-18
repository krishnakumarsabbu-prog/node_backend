import { generateText, type CoreTool, type GenerateTextResult } from "ai";
import { getTachyonModel } from "../../modules/llm/providers/tachyon";
import type { FileMap } from "../constants";
import type { BatchFile, BatchPlan } from "./batch-types";
import { createScopedLogger } from "../../utils/logger";

const logger = createScopedLogger("batch-planner");

function getFilePaths(files: FileMap): string[] {
  return Object.entries(files)
    .filter(([, entry]) => entry?.type === "file" && !(entry as any).isBinary)
    .map(([path]) => path);
}

/**
 * Ask the LLM to select which files in the project need to be touched
 * to fulfill a user request.
 *
 * Returns a BatchPlan. The caller decides whether to execute file-per-step
 * (when files.length > threshold) or fall back to topic-based steps.
 *
 * IMPORTANT: No exclusions on test files, docs, or any file type — the LLM
 * should decide what is needed based purely on the user request.
 */
export async function selectFilesForBuild(
  userQuestion: string,
  files: FileMap,
  onFinish?: (resp: GenerateTextResult<Record<string, CoreTool<any, any>>, never>) => void,
): Promise<BatchPlan> {
  const allPaths = getFilePaths(files);

  logger.info(`Selecting files from ${allPaths.length} candidates for: "${userQuestion.substring(0, 80)}"`);

  if (allPaths.length === 0) {
    return { files: [], totalSteps: 0, userIntent: userQuestion };
  }

  const resp = await generateText({
    model: getTachyonModel(),
    system: `
You are a senior software architect performing precise change-impact analysis.

Given a user request and a list of project files, identify every file that must be created or modified to fully satisfy the request — nothing more, nothing less.

Return ONLY a valid JSON array. No prose, no markdown fences, no explanation.
Each element must have exactly two fields:
  "path"   : string — exact path from the provided list for existing files, or a new path that follows the project's existing naming and directory conventions
  "reason" : string — one precise sentence describing what must change or be created in this file

HOW TO REASON ABOUT SCOPE:

1. Read the request literally first. What is the user actually asking for?
   - A targeted fix ("change the button color") → affects only the files directly involved
   - A broad operation ("add dark mode to everything") → affects all relevant files across the project
   - A cross-cutting concern ("add logging to all services") → every service file is in scope
   - A feature ("add a search bar to the header") → affects the component, its styles, any state or data it needs

2. Trace dependencies. If a file must change, ask: does any other file need to change as a consequence?
   - A new exported type → all files that import it may need updating
   - A new API endpoint → the route file, the handler, the client-side fetch, and any type definitions
   - A schema change → the model, any queries that use it, and the UI that displays it

3. Match scope to intent. Do not over-include:
   - If the user asked about one component, do not include every component in the project
   - If the user asked to fix a bug in one file, do not include unrelated files
   - If the user asked to add a feature to all files of a certain type, include all of them

4. New files: only include them if the request clearly calls for them or if a new file is the correct architectural choice (e.g. a new route requires a new handler file). Follow the project's existing file naming and directory structure.

5. Return an empty array [] only if the request cannot be mapped to any specific file (e.g. a purely conceptual question). Never return an empty array for an actionable request.

OUTPUT: JSON array only.
`,
    prompt: `
User request: "${userQuestion}"

Project files:
${allPaths.join("\n")}

Return the JSON array of files that need to be created or modified to fulfill this request.
`,
  });

  if (onFinish) onFinish(resp);

  let batchFiles: BatchFile[] = [];

  try {
    const cleaned = resp.text.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "");
    batchFiles = JSON.parse(cleaned) as BatchFile[];
    logger.info(`File selector identified ${batchFiles.length} files`);
  } catch (err: any) {
    logger.error("Failed to parse file selection response", err);
    batchFiles = [];
  }

  return {
    files: batchFiles,
    totalSteps: batchFiles.length,
    userIntent: userQuestion,
  };
}

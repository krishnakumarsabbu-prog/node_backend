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
You are a code analysis assistant. The user wants to perform a task across their project.
Identify EXACTLY which files need to be created or modified to fulfill the request.

Return ONLY a valid JSON array — no prose, no markdown fences, no explanation.
Each element must have:
"path"   : string  (exact file path from the provided list, or a new file path following project conventions)
"reason" : string  (one sentence: what specifically needs to change in this file)

Rules:
- Only include files that DIRECTLY need to be created or modified
- Do NOT include config files, lock files, test files, or unrelated files
- For new files, follow the naming and directory conventions already in the project
- Preserve exact paths as given
- Do NOT wrap output in markdown code fences
`,
    prompt: `
User request: "${userQuestion}"

Available project files:
${allPaths.join("\n")}

Return the JSON array of files that need to be created or modified.
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

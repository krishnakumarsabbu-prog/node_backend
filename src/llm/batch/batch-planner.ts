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

export async function planBatchExecution(
  userQuestion: string,
  files: FileMap,
  onFinish?: (resp: GenerateTextResult<Record<string, CoreTool<any, any>>, never>) => void,
): Promise<BatchPlan> {
  const allPaths = getFilePaths(files);

  logger.info(`Planning batch execution for ${allPaths.length} available files`);

  if (allPaths.length === 0) {
    return { files: [], totalSteps: 0, userIntent: userQuestion };
  }

  const resp = await generateText({
    model: getTachyonModel(),
    system: `
You are a code analysis assistant. The user wants to perform a task across multiple files in their project.
Your job is to identify EXACTLY which files need to be modified or generated to fulfill the user's request.

Return ONLY a valid JSON array — no prose, no markdown fences, no explanation.
Each element must have:
"path"   : string  (exact file path from the provided list, or a new file path if needed)
"reason" : string  (one sentence: why this file needs to be touched for the user's request)

Rules:
- Only include files that DIRECTLY need to be created or modified for the task
- Do NOT include config files, lock files, or unrelated files
- If the user asks for "all files" of a certain type (e.g. "all components"), include all matching files
- Preserve exact paths as given in the file list
- For new files that don't exist yet, use a sensible path following existing conventions
- Do NOT wrap output in markdown code fences
`,
    prompt: `
User request: "${userQuestion}"

Available project files:
${allPaths.join("\n")}

Return the JSON array of files that need to be processed for this request.
`,
  });

  if (onFinish) onFinish(resp);

  let batchFiles: BatchFile[] = [];

  try {
    const cleaned = resp.text.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "");
    batchFiles = JSON.parse(cleaned) as BatchFile[];
    logger.info(`Planner identified ${batchFiles.length} files to process`);
  } catch (err: any) {
    logger.error("Failed to parse batch plan response, falling back to all source files", err);
    batchFiles = allPaths
      .filter((p) => !p.includes("node_modules") && !p.includes(".git"))
      .map((p) => ({ path: p, reason: "Identified by fallback (LLM parse failed)" }));
  }

  return {
    files: batchFiles,
    totalSteps: batchFiles.length,
    userIntent: userQuestion,
  };
}

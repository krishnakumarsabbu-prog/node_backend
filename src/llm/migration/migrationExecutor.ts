import { generateText } from "ai";
import type { FileMap } from "../constants";
import type { MigrationPlan, MigrationResult } from "./migrationTypes";
import { createScopedLogger } from "../../utils/logger";
import { getTachyonModel } from "../../modules/llm/providers/tachyon";

const logger = createScopedLogger("migration-executor");

const MODIFICATION_PROMPT = `You are a senior software engineer implementing a migration task.

Generate the COMPLETE updated file content for the specified modification.

CRITICAL RULES:
1. Return ONLY the complete file content
2. NO explanations, NO markdown code blocks, NO additional text
3. The output must be valid source code that can be written directly to the file
4. Implement the exact changes described in the task

TASK DETAILS:
File: {{FILE_PATH}}
Action: {{ACTION}}
Description: {{DESCRIPTION}}

CURRENT FILE CONTENT:
{{CURRENT_CONTENT}}

Return ONLY the complete updated file content:`;

const CREATION_PROMPT = `You are a senior software engineer implementing a migration task.

Generate the COMPLETE content for a new file as specified.

CRITICAL RULES:
1. Return ONLY the complete file content
2. NO explanations, NO markdown code blocks, NO additional text
3. The output must be valid source code that can be written directly to the file
4. Implement the exact requirements described in the task

TASK DETAILS:
File: {{FILE_PATH}}
Action: create
Description: {{DESCRIPTION}}

Return ONLY the complete file content:`;

export async function executeMigrationPlan(
  plan: MigrationPlan,
  files: FileMap
): Promise<MigrationResult> {
  logger.info(`Executing migration plan: ${plan.tasks.length} tasks`);

  const result: MigrationResult = {
    filesModified: 0,
    filesCreated: 0,
    filesDeleted: 0,
    modifiedFiles: {},
    createdFiles: {},
    deletedFiles: [],
  };

  for (const task of plan.tasks) {
    logger.info(`Processing task: ${task.action} ${task.file}`);

    try {
      if (task.action === "delete") {
        result.deletedFiles.push(task.file);
        result.filesDeleted++;
      } else if (task.action === "modify") {
        const currentFile = files[task.file] as any;
        if (!currentFile) {
          logger.warn(`File not found for modification: ${task.file}`);
          continue;
        }

        const currentContent = currentFile.content || "";

        const prompt = MODIFICATION_PROMPT.replace("{{FILE_PATH}}", task.file)
          .replace("{{ACTION}}", task.action)
          .replace("{{DESCRIPTION}}", task.description)
          .replace("{{CURRENT_CONTENT}}", currentContent);

        const llmResult = await generateText({
          model: getTachyonModel(),
          messages: [{ role: "user", content: prompt }],
          maxTokens: 8192,
        });

        const newContent = llmResult.text.trim();

        result.modifiedFiles[task.file] = newContent;
        result.filesModified++;
      } else if (task.action === "create") {
        const prompt = CREATION_PROMPT.replace("{{FILE_PATH}}", task.file).replace(
          "{{DESCRIPTION}}",
          task.description
        );

        const llmResult = await generateText({
          model: getTachyonModel(),
          messages: [{ role: "user", content: prompt }],
          maxTokens: 8192,
        });

        const newContent = llmResult.text.trim();

        result.createdFiles[task.file] = newContent;
        result.filesCreated++;
      }
    } catch (error: any) {
      logger.error(`Failed to process task for ${task.file}: ${error.message}`);
    }
  }

  logger.info(
    `Migration execution complete: ${result.filesModified} modified, ${result.filesCreated} created, ${result.filesDeleted} deleted`
  );

  return result;
}

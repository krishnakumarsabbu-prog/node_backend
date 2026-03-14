import { generateText } from "ai";
import type { FileMap } from "../constants";
import type { Messages } from "../stream-text";
import type { MigrationPlan, ProjectAnalysis } from "./migrationTypes";
import { createScopedLogger } from "../../utils/logger";
import { getTachyonModel } from "../../modules/llm/providers/tachyon";

const logger = createScopedLogger("migration-planner");

const MIGRATION_PLANNER_PROMPT = `You are a senior software architect specializing in application migrations.

Your task is to analyze a project and generate a detailed migration plan.

CRITICAL RULES:
1. DO NOT include full file code in your response
2. ONLY return a structured migration plan
3. For each file, specify: file path, action (modify/delete/create), and a clear description
4. Be specific about what changes are needed
5. Return ONLY valid JSON in the exact format specified below

Analyze the project and return a migration plan in this EXACT JSON format:

{
  "migrationType": "string describing the migration (e.g., 'spring_mvc_to_spring_boot')",
  "summary": {
    "filesToModify": <number>,
    "filesToDelete": <number>,
    "filesToCreate": <number>
  },
  "tasks": [
    {
      "file": "path/to/file",
      "action": "modify" | "delete" | "create",
      "description": "Clear description of what needs to be done"
    }
  ]
}

Return ONLY the JSON object, no additional text or explanation.`;

export async function generateMigrationPlan(
  files: FileMap,
  messages: Messages,
  analysis: ProjectAnalysis
): Promise<MigrationPlan> {
  logger.info("Generating migration plan");

  const fileList = Object.keys(files)
    .map((path) => {
      const fileDetails = files[path] as any;
      const size = fileDetails?.content?.length || 0;
      return `- ${path} (${size} bytes)`;
    })
    .join("\n");

  const userMessage = messages[messages.length - 1];
  const userRequest = typeof userMessage.content === "string" ? userMessage.content : "";

  const prompt = `${MIGRATION_PLANNER_PROMPT}

PROJECT ANALYSIS:
Framework: ${analysis.framework || "unknown"}
Build Tool: ${analysis.buildTool || "unknown"}
XML Configs: ${analysis.xmlConfigs?.length || 0} files
Controllers: ${analysis.controllers?.length || 0} files
Services: ${analysis.services?.length || 0} files
Repositories: ${analysis.repositories?.length || 0} files

USER REQUEST:
${userRequest}

PROJECT FILES:
${fileList}

Generate the migration plan:`;

  try {
    const result = await generateText({
      model: getTachyonModel(),
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      maxTokens: 4096,
    });

    const responseText = result.text.trim();

    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    const jsonText = jsonMatch ? jsonMatch[0] : responseText;

    const plan = JSON.parse(jsonText) as MigrationPlan;

    logger.info(
      `Migration plan generated: ${plan.tasks.length} tasks, type=${plan.migrationType}`
    );

    return plan;
  } catch (error: any) {
    logger.error(`Failed to generate migration plan: ${error.message}`);
    throw new Error(`Migration plan generation failed: ${error.message}`);
  }
}

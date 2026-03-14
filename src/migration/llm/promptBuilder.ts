import type { ProjectAnalysis, BuildError } from "../types/migrationTypes";
import type { FileMap } from "../../llm/constants";

export class PromptBuilder {
  static buildAnalysisPrompt(files: FileMap): string {
    const fileList = Object.keys(files)
      .map((path) => {
        const file = files[path];
        const size = file && 'content' in file ? file.content?.length || 0 : 0;
        return `- ${path} (${size} bytes)`;
      })
      .join("\n");

    return `Analyze this project structure and identify:
- Framework and version
- Build tool
- Configuration files
- Entry points
- Dependencies

PROJECT FILES:
${fileList}

Return a structured analysis.`;
  }

  static buildPlanningPrompt(
    analysis: ProjectAnalysis,
    userRequest: string,
    fileList: string[]
  ): string {
    return `You are a senior software architect generating a migration plan.

PROJECT ANALYSIS:
Framework: ${analysis.framework}
Build Tool: ${analysis.buildTool}
Controllers: ${analysis.controllers.length}
Services: ${analysis.services.length}
Config Files: ${analysis.configFiles.length}

USER REQUEST:
${userRequest}

AVAILABLE FILES:
${fileList.slice(0, 50).join("\n")}
${fileList.length > 50 ? `... and ${fileList.length - 50} more files` : ""}

CRITICAL RULES:
1. DO NOT include full file code
2. ONLY return structured JSON migration plan
3. Each task must specify: file, action (modify/delete/create), description
4. Be specific about changes needed
5. Prioritize tasks (0-10)
6. Reference only files that exist in the project

Return ONLY valid JSON in this exact format:
{
  "migrationType": "descriptive_name",
  "summary": {
    "filesToModify": <number>,
    "filesToDelete": <number>,
    "filesToCreate": <number>
  },
  "tasks": [
    {
      "file": "path/to/file",
      "action": "modify|delete|create",
      "description": "specific changes needed",
      "priority": <0-10>
    }
  ],
  "estimatedComplexity": "low|medium|high"
}`;
  }

  static buildCodingPrompt(
    filePath: string,
    action: string,
    description: string,
    currentContent?: string
  ): string {
    if (action === "create") {
      return `Generate complete file content for a new file.

FILE: ${filePath}
TASK: ${description}

RULES:
1. Return ONLY the complete file content
2. NO explanations, NO markdown blocks
3. Must be valid, compilable code
4. Follow best practices and conventions

Generate the file:`;
    }

    if (action === "modify") {
      return `Modify an existing file according to the task description.

FILE: ${filePath}
TASK: ${description}

CURRENT CONTENT:
${currentContent}

RULES:
1. Return ONLY the complete updated file content
2. NO explanations, NO markdown blocks
3. Preserve existing code structure where possible
4. Must be valid, compilable code
5. Make ONLY the changes described in the task

Generate the updated file:`;
    }

    return "";
  }

  static buildRepairPrompt(
    buildErrors: BuildError[],
    affectedFiles: string[],
    attemptNumber: number
  ): string {
    const errorSummary = buildErrors
      .map((err) => `- [${err.type}] ${err.file || "unknown"}:${err.line || "?"} - ${err.message}`)
      .join("\n");

    return `You are a senior engineer fixing build errors after a migration.

ATTEMPT: ${attemptNumber}/5

BUILD ERRORS:
${errorSummary}

AFFECTED FILES:
${affectedFiles.join("\n")}

Analyze the errors and generate fixes.

RULES:
1. Return ONLY valid JSON
2. Each fix must specify: file, action, content, reasoning
3. Focus on compilation errors first
4. Provide complete file content, not diffs

Return JSON in this format:
{
  "success": true,
  "fixes": [
    {
      "file": "path/to/file",
      "action": "modify",
      "content": "complete file content"
    }
  ],
  "reasoning": "explanation of fixes"
}`;
  }

  static buildVerificationPrompt(buildLogs: string): string {
    return `Parse build output and extract structured errors.

BUILD LOGS:
${buildLogs.slice(0, 5000)}

Extract:
- File paths with errors
- Line numbers
- Error messages
- Error types (compilation/dependency/configuration)

Return structured JSON.`;
  }
}

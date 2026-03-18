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

  private static sampleFileList(fileList: string[], maxFiles: number): { sample: string[]; truncated: boolean; totalCount: number } {
    if (fileList.length <= maxFiles) {
      return { sample: fileList, truncated: false, totalCount: fileList.length };
    }

    const configPatterns = /\.(xml|gradle|json|yaml|yml|toml|properties|env)$|^(pom\.xml|build\.gradle|package\.json|settings\.gradle|Cargo\.toml|requirements\.txt|Gemfile|composer\.json)$/i;
    const entryPatterns = /\/(main|app|index|application|server|bootstrap)\./i;
    const testPatterns = /\.(test|spec)\.|\/test\/|\/tests\//i;

    const priority: string[] = [];
    const normal: string[] = [];
    const tests: string[] = [];

    for (const f of fileList) {
      const name = f.split('/').pop() || f;
      if (configPatterns.test(name) || configPatterns.test(f)) priority.push(f);
      else if (entryPatterns.test(f)) priority.push(f);
      else if (testPatterns.test(f)) tests.push(f);
      else normal.push(f);
    }

    const reserved = Math.min(priority.length, Math.floor(maxFiles * 0.3));
    const remaining = maxFiles - reserved;
    const sample = [
      ...priority.slice(0, reserved),
      ...normal.slice(0, remaining),
    ].slice(0, maxFiles);

    return { sample, truncated: true, totalCount: fileList.length };
  }

  static buildMigrationDocumentPrompt(
    analysis: ProjectAnalysis,
    userRequest: string,
    fileList: string[],
    fileContents: Record<string, string>
  ): string {
    const MAX_FILES_IN_PROMPT = 150;
    const { sample, truncated, totalCount } = PromptBuilder.sampleFileList(fileList, MAX_FILES_IN_PROMPT);

    const fileSection = truncated
      ? `${sample.join("\n")}\n\n[Note: Showing ${sample.length} representative files out of ${totalCount} total. All files must be accounted for in the migration — apply patterns consistently to files not listed.]`
      : sample.join("\n");

    const contentSamples = Object.entries(fileContents)
      .slice(0, 10)
      .map(([path, content]) => `### ${path}\n\`\`\`\n${content.slice(0, 800)}${content.length > 800 ? "\n...[truncated]" : ""}\n\`\`\``)
      .join("\n\n");

    return `You are a senior software architect generating a complete, production-ready migration plan document.

PROJECT ANALYSIS:
Framework: ${analysis.framework}
Build Tool: ${analysis.buildTool}
Controllers: ${analysis.controllers.length}
Services: ${analysis.services.length}
Config Files: ${analysis.configFiles.length}
Total Files: ${totalCount}

USER REQUEST:
${userRequest}

AVAILABLE FILES (all must be migrated — miss nothing):
${fileSection}

SAMPLE FILE CONTENTS (for context):
${contentSamples || "(none available)"}

---

YOUR TASK:
Generate a complete Migration.md document that serves as a step-by-step implementation guide.

The migration creates a NEW project at: /home/project/migrate/

CRITICAL RULES:
1. EVERY source file from the original project must have a corresponding entry in the migration — do NOT omit any business logic, configuration, or resource file
2. The migrate/ folder is a completely fresh project — include ALL setup files (build file, main entry, config files, etc.)
3. Each step must be self-contained and implementable by an LLM coding agent
4. Steps must be ordered so later steps never depend on files created by later steps
5. Describe exactly what each file must contain — reference class names, method signatures, annotations, config keys
6. Preserve 100% of the business logic — no feature may be dropped in the migration

MIGRATION.md FORMAT:
Write a proper markdown document with:
- A title: # Migration Plan: [source framework] → [target framework]
- A ## Overview section describing what is being migrated and why
- A ## Migration Strategy section explaining the approach
- A ## Target Structure section showing the directory tree of migrate/
- Numbered ## Step N: [Action Title] sections — one per logical group of files
  - Each step has a ### Goal subsection and a ### Files subsection
  - Under ### Files, list each file as: **\`migrate/path/to/file\`** — [description of exactly what it should contain]
- A ## Dependency Changes section listing all new/removed packages
- A ## Key Differences section noting behavioral changes

Write the full Migration.md document now:`;
  }

  static buildPlanningPrompt(
    analysis: ProjectAnalysis,
    userRequest: string,
    fileList: string[]
  ): string {
    const MAX_FILES_IN_PROMPT = 200;
    const { sample, truncated, totalCount } = PromptBuilder.sampleFileList(fileList, MAX_FILES_IN_PROMPT);

    const fileSection = truncated
      ? `${sample.join("\n")}\n\n[Note: Showing ${sample.length} representative files out of ${totalCount} total. Config files, entry points, and source files are prioritized. Apply migration patterns consistently to all similar files not listed.]`
      : sample.join("\n");

    return `You are a senior software architect generating a migration plan.

PROJECT ANALYSIS:
Framework: ${analysis.framework}
Build Tool: ${analysis.buildTool}
Controllers: ${analysis.controllers.length}
Services: ${analysis.services.length}
Config Files: ${analysis.configFiles.length}
Total Files: ${totalCount}

USER REQUEST:
${userRequest}

AVAILABLE FILES:
${fileSection}

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

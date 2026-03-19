import type { ProjectAnalysis, BuildError } from "../types/migrationTypes";
import type { FileMap } from "../../llm/constants";
import type { CodebaseIntelligence } from "../intelligence/contextBuilder";
import { buildMigrationContextPrompt } from "../intelligence/contextBuilder";

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

  static buildMigrationDocumentPrompt(
    analysis: ProjectAnalysis,
    userRequest: string,
    fileList: string[],
    fileContents: Record<string, string>,
    intelligence?: CodebaseIntelligence
  ): string {
    if (intelligence) {
      return PromptBuilder.buildIntelligentMigrationDocumentPrompt(intelligence, userRequest);
    }

    const MAX_FILES_IN_PROMPT = 150;
    const { sample, truncated, totalCount } = PromptBuilder.sampleFileList(fileList, MAX_FILES_IN_PROMPT);

    const fileSection = truncated
      ? `${sample.join("\n")}\n\n[Note: Showing ${sample.length} representative files out of ${totalCount} total. All files must be accounted for in the migration — apply patterns consistently to files not listed.]`
      : sample.join("\n");

    const contentSamples = Object.entries(fileContents)
      .slice(0, 10)
      .map(([path, content]) => `### ${path}\n\`\`\`\n${content.slice(0, 800)}${content.length > 800 ? "\n...[truncated]" : ""}\n\`\`\``)
      .join("\n\n");

    return `You are a senior Spring migration architect generating a complete, production-ready migration plan document.

PROJECT ANALYSIS:
Framework: ${analysis.framework}
Build Tool: ${analysis.buildTool}
Controllers: ${analysis.controllers.length}
Services: ${analysis.services.length}
Config Files: ${analysis.configFiles.length}
Total Files: ${totalCount}

USER REQUEST:
${userRequest}

AVAILABLE FILES (all must be migrated — INCLUDING XML, properties, and resources — miss nothing):
${fileSection}

SAMPLE FILE CONTENTS (CRITICAL for understanding XML + configuration behavior):
${contentSamples || "(none available)"}

${PromptBuilder.getMigrationDocumentInstructions()}`;
  }

  private static buildIntelligentMigrationDocumentPrompt(
    intelligence: CodebaseIntelligence,
    userRequest: string
  ): string {
    const context = buildMigrationContextPrompt(intelligence, userRequest);

    return `You are a senior Spring migration architect generating a complete, production-ready migration plan document.

You have been provided with structured codebase intelligence — NOT raw file contents. This intelligence was extracted by a pre-processing pipeline that analyzed all files, built a dependency graph, parsed XML configurations, and detected migration patterns.

Use this structured intelligence to generate an accurate, complete Migration.md document.

---

${context}

---

${PromptBuilder.getMigrationDocumentInstructions()}`;
  }

  private static getMigrationDocumentInstructions(): string {
    return `YOUR TASK:
Generate a complete Migration.md document that serves as a step-by-step implementation guide.

The migration creates a NEW project at: /home/project/migrate/

---

CRITICAL RULES:

1. EVERY source file from the original project must have a corresponding entry in the migration — do NOT omit any business logic, configuration, XML, or resource file

2. THIS IS A SPRING WEB MVC → SPRING BOOT MIGRATION:
   - You MUST analyze XML configuration files deeply (web.xml, dispatcher-servlet.xml, applicationContext.xml, etc.)
   - You MUST transform XML-based configuration into Spring Boot Java configuration or properties

3. XML TRANSFORMATION RULES (MANDATORY):
   - web.xml → Spring Boot main class + embedded server configuration (REMOVE web.xml entirely)
   - dispatcher-servlet.xml → @Configuration or rely on Spring Boot auto-configuration
   - applicationContext.xml → @Configuration classes with @Bean methods
   - <bean> definitions → @Component / @Service / @Repository / @Bean
   - context:component-scan → @SpringBootApplication or @ComponentScan
   - property placeholders → application.properties or application.yml
   - view resolvers / handler mappings → Spring Boot defaults unless customization is required

4. DO NOT COPY XML FILES INTO THE TARGET PROJECT:
   - You must CONVERT them, not migrate as-is
   - Clearly explain where each XML configuration is moved

5. EVERY XML FILE MUST HAVE AN EXPLICIT TRANSFORMATION EXPLANATION:
   - What the XML file does
   - What replaces it in Spring Boot
   - Which new file(s) contain that logic

6. The migrate/ folder is a completely fresh Spring Boot project — include ALL setup files:
   - Main class with @SpringBootApplication
   - application.properties or application.yml
   - Build file with Spring Boot dependencies
   - Proper package structure

7. Each step must be self-contained and implementable by an LLM coding agent

8. Steps must be ordered so later steps never depend on files created by later steps

9. Describe exactly what each file must contain — reference:
   - Class names
   - Method signatures
   - Annotations
   - Configuration keys

10. Preserve 100% of the business logic — ONLY change configuration style (XML → annotations/config)

---

MIGRATION.md FORMAT:

Write a proper markdown document with:

- A title: # Migration Plan: Spring Web MVC → Spring Boot

- A ## Overview section describing what is being migrated and why

- A ## Migration Strategy section explaining:
  - XML → Java config transformation
  - Embedded server model
  - Auto-configuration approach

- A ## Target Structure section showing the directory tree of migrate/

- Numbered ## Step N: [Action Title] sections — one per logical group of files
  - Each step has a ### Goal subsection and a ### Files subsection
  - Under ### Files, list each file as:
    **\`migrate/path/to/file\`** — [description of exactly what it should contain]

---

🚨 MANDATORY SECTION:

## XML to Spring Boot Mapping

For EACH XML file found in the input:

### [xml-file-name]
- Purpose:
- Key configurations:
- Spring Boot replacement:
- Target file(s):
- Exact transformation explanation

---

- A ## Dependency Changes section listing all new/removed packages

- A ## Key Differences section noting behavioral changes

---

Write the full Migration.md document now:`;
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

  static buildPlanningPrompt(
    analysis: ProjectAnalysis,
    userRequest: string,
    fileList: string[],
    intelligence?: CodebaseIntelligence
  ): string {
    if (intelligence) {
      return PromptBuilder.buildIntelligentPlanningPrompt(intelligence, userRequest);
    }

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

${PromptBuilder.getPlanningJsonInstructions()}`;
  }

  private static buildIntelligentPlanningPrompt(intelligence: CodebaseIntelligence, userRequest: string): string {
    const context = buildMigrationContextPrompt(intelligence, userRequest);

    return `You are a senior software architect generating a structured migration plan.

You have been provided with structured codebase intelligence extracted by an analysis pipeline. Use this intelligence to produce an accurate migration plan.

---

${context}

---

${PromptBuilder.getPlanningJsonInstructions()}`;
  }

  private static getPlanningJsonInstructions(): string {
    return `CRITICAL RULES:
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

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

    return `You are a senior Spring migration architect generating a complete, production-ready migration plan.

You have been provided with structured codebase intelligence — NOT raw file contents. This intelligence was extracted by a pre-processing pipeline that:
- Analyzed all Java/XML/build files semantically
- Built a dependency graph with circular dependency detection
- Parsed all XML configuration files (web.xml, applicationContext.xml, etc.)
- Detected migration patterns (field injection, legacy dispatcher, missing Boot main, etc.)

Use this structured intelligence to generate BOTH a Migration.md document AND a structured task list.

---

${context}

---

${PromptBuilder.getMigrationDocumentInstructions()}`;
  }

  private static getMigrationDocumentInstructions(): string {
    return `YOUR TASK:
Generate a DUAL OUTPUT: (1) a complete Migration.md document AND (2) a structured task list JSON.

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

4. FIELD INJECTION → CONSTRUCTOR INJECTION:
   - If the project uses field injection (@Autowired on fields), convert to constructor injection in the target

5. DO NOT COPY XML FILES INTO THE TARGET PROJECT:
   - You must CONVERT them, not migrate as-is

6. The migrate/ folder is a completely fresh Spring Boot project — include ALL setup files:
   - Main class with @SpringBootApplication
   - application.properties or application.yml
   - Build file with Spring Boot dependencies
   - Proper package structure

7. Each step must be self-contained and ordered (earlier steps must not depend on later steps)

8. Describe exactly what each file must contain — reference class names, method signatures, annotations, config keys

9. Preserve 100% of the business logic — ONLY change configuration style

---

OUTPUT FORMAT (MANDATORY DUAL OUTPUT):

You MUST return your response in EXACTLY this structure:

\`\`\`json
{
  "markdown": "<FULL Migration.md content as a string — include all sections, properly escaped>",
  "tasks": [
    {
      "id": "task-001",
      "title": "Create Spring Boot main application class",
      "type": "build",
      "files": ["migrate/src/main/java/com/example/Application.java"],
      "dependsOn": [],
      "description": "Create @SpringBootApplication entry point replacing web.xml"
    },
    {
      "id": "task-002",
      "title": "Update pom.xml for Spring Boot",
      "type": "build",
      "files": ["migrate/pom.xml"],
      "dependsOn": [],
      "description": "Add spring-boot-starter-parent, spring-boot-starter-web, spring-boot-maven-plugin"
    }
  ]
}
\`\`\`

TASK RULES:
- Each task MUST have: id, title, type, files[], dependsOn[], description
- id must be unique: "task-001", "task-002", etc.
- type must be one of: "build" | "config" | "code" | "resource"
  - "build": pom.xml, build files, main class
  - "config": application.properties, @Configuration classes, replacing XML configs
  - "code": controllers, services, repositories, models
  - "resource": static files, templates, other non-code resources
- files[] must list ALL target files created/modified in this task (paths under migrate/)
- dependsOn[] must list task IDs that MUST be completed before this task
- Tasks must be ordered: build → config → code → resource
- NO orphan tasks (every dependsOn id must exist)
- NO circular dependencies in tasks

---

MIGRATION.md CONTENT (inside the "markdown" field) MUST INCLUDE:

# Migration Plan: Spring Web MVC → Spring Boot

## Overview
[What is being migrated and why]

## Migration Strategy
[XML → Java config transformation, embedded server model, auto-configuration approach]

## Target Structure
[Directory tree of migrate/]

## Step N: [Action Title]
[One section per logical group of files]
### Goal
### Files
**\`migrate/path/to/file\`** — [description]

## XML to Spring Boot Mapping
[For EACH XML file: Purpose, Key configurations, Spring Boot replacement, Target file(s)]

## Dependency Changes
[New/removed packages]

## Key Differences
[Behavioral changes]

---

Return ONLY the JSON block. No explanations before or after it.`;
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

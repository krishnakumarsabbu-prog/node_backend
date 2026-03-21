import type { ProjectAnalysis, BuildError, MigrationPlan } from "../types/migrationTypes";
import type { FileMap } from "../../llm/constants";
import type { CodebaseIntelligence } from "../intelligence/contextBuilder";
import { buildMigrationContextPrompt } from "../intelligence/contextBuilder";
import type { MigrationPlanVerificationResult } from "../agents/migrationPlanVerifierAgent";

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

  static buildMarkdownOnlyPrompt(
    intelligence: CodebaseIntelligence,
    userRequest: string
  ): string {
    const p = intelligence.patterns;
    const k = intelligence.keyFiles;
    const sa = intelligence.springArtifacts;

    const artifactLines: string[] = [];
    if (sa) {
      const base = (f: string) => f.split("/").pop() ?? f;
      if (sa.filters.length) artifactLines.push(`Filters (${sa.filters.length}): ${sa.filters.map(base).join(", ")} — convert to FilterRegistrationBean`);
      if (sa.interceptors.length) artifactLines.push(`Interceptors (${sa.interceptors.length}): ${sa.interceptors.map(base).join(", ")} — register via WebMvcConfigurer.addInterceptors()`);
      if (sa.aspects.length) artifactLines.push(`AOP Aspects (${sa.aspects.length}): ${sa.aspects.map(base).join(", ")} — add @EnableAspectJAutoProxy`);
      if (sa.exceptionHandlers.length) artifactLines.push(`Exception Handlers (${sa.exceptionHandlers.length}): ${sa.exceptionHandlers.map(base).join(", ")} — convert to @RestControllerAdvice`);
      if (sa.scheduledTasks.length) artifactLines.push(`Scheduled Tasks (${sa.scheduledTasks.length}): ${sa.scheduledTasks.map(base).join(", ")} — add @EnableScheduling`);
      if (sa.converters.length) artifactLines.push(`Converters (${sa.converters.length}): ${sa.converters.map(base).join(", ")} — register via WebMvcConfigurer.addFormatters()`);
      if (sa.validators.length) artifactLines.push(`Validators (${sa.validators.length}): ${sa.validators.map(base).join(", ")} — register via WebMvcConfigurer.getValidator()`);
    }

    const context = [
      `Framework: ${intelligence.framework} | Build: ${intelligence.buildTool}`,
      `Controllers: ${intelligence.stats.controllers} | Services: ${intelligence.stats.services} | Repos: ${intelligence.stats.repositories} | XML configs: ${intelligence.stats.xmlConfigFiles}`,
      `Patterns: fieldInjection=${p.usesFieldInjection}, xmlConfig=${p.usesXmlConfiguration}, legacyDispatcher=${p.hasLegacyDispatcher}, missingBootMain=${p.missingBootMain}, circularDeps=${intelligence.graphSummary.circularDependencies}`,
      k.controllers.length ? `Controllers: ${k.controllers.slice(0, 8).join(", ")}` : null,
      k.services.length ? `Services: ${k.services.slice(0, 8).join(", ")}` : null,
      k.configs.length ? `Configs: ${k.configs.slice(0, 8).join(", ")}` : null,
      intelligence.xmlConfigs.length
        ? `XML files: ${intelligence.xmlConfigs.map((x) => x.file).join(", ")}`
        : null,
      artifactLines.length ? `\nSPRING ARTIFACTS (ALL must be covered in the migration plan):\n${artifactLines.join("\n")}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    return `You are a senior Spring migration architect.

USER REQUEST: ${userRequest}

PROJECT INTELLIGENCE:
${context}

Generate a complete Migration.md document for migrating Spring Web MVC → Spring Boot.

RULES:
- Output ONLY the markdown text — no JSON, no code blocks wrapping the whole doc
- Cover: Overview, Migration Strategy, Target Structure, Steps (one per logical group), XML→Boot Mapping, Dependency Changes, Key Differences
- Every XML config file must have a dedicated mapping entry
- Reference actual class/file names from the intelligence above
- Migration target goes under migrate/
- If field injection is detected, mention constructor injection conversion
- If circular deps exist (${intelligence.graphSummary.circularDependencies}), include a resolution step
- Every Spring Artifact listed above (filters, interceptors, AOP aspects, exception handlers, scheduled tasks) MUST have explicit migration steps

Start with: # Migration Plan: Spring Web MVC → Spring Boot`;
  }

  static buildTasksOnlyPrompt(
    intelligence: CodebaseIntelligence,
    userRequest: string,
    markdownSummary: string
  ): string {
    const p = intelligence.patterns;
    const sa = intelligence.springArtifacts;
    const allFiles = [
      ...intelligence.keyFiles.controllers,
      ...intelligence.keyFiles.services,
      ...intelligence.keyFiles.repositories,
      ...intelligence.keyFiles.configs,
      ...intelligence.keyFiles.entryPoints,
      ...intelligence.xmlConfigs.map((x) => x.file),
    ].slice(0, 60);

    const artifactTaskHints: string[] = [];
    if (sa) {
      const base = (f: string) => f.split("/").pop() ?? f;
      if (sa.filters.length) artifactTaskHints.push(`- Filters: ${sa.filters.map(base).join(", ")} → each needs a "config" task creating FilterRegistrationBean`);
      if (sa.interceptors.length) artifactTaskHints.push(`- Interceptors: ${sa.interceptors.map(base).join(", ")} → needs a "config" task for WebMvcConfigurer.addInterceptors()`);
      if (sa.aspects.length) artifactTaskHints.push(`- AOP Aspects: ${sa.aspects.map(base).join(", ")} → needs @EnableAspectJAutoProxy in a "config" task`);
      if (sa.exceptionHandlers.length) artifactTaskHints.push(`- Exception Handlers: ${sa.exceptionHandlers.map(base).join(", ")} → "code" tasks with @RestControllerAdvice`);
      if (sa.scheduledTasks.length) artifactTaskHints.push(`- Scheduled Tasks: ${sa.scheduledTasks.map(base).join(", ")} → @EnableScheduling required in a "config" task`);
      if (sa.converters.length) artifactTaskHints.push(`- Converters: ${sa.converters.map(base).join(", ")} → register in WebMvcConfigurer.addFormatters() "config" task`);
      if (sa.validators.length) artifactTaskHints.push(`- Validators: ${sa.validators.map(base).join(", ")} → register in WebMvcConfigurer.getValidator() "config" task`);
    }

    const context = [
      `Framework: ${intelligence.framework} | Build: ${intelligence.buildTool}`,
      `Controllers: ${intelligence.stats.controllers} | Services: ${intelligence.stats.services} | Repos: ${intelligence.stats.repositories}`,
      `Patterns: fieldInjection=${p.usesFieldInjection}, xmlConfig=${p.usesXmlConfiguration}, missingBootMain=${p.missingBootMain}`,
      `Key source files: ${allFiles.join(", ")}`,
      artifactTaskHints.length ? `\nSPRING ARTIFACTS requiring dedicated tasks:\n${artifactTaskHints.join("\n")}` : null,
    ].filter(Boolean).join("\n");

    return `You are a senior Spring migration architect.

USER REQUEST: ${userRequest}

PROJECT INTELLIGENCE:
${context}

MIGRATION SUMMARY (from already-generated migration.md):
${markdownSummary.slice(0, 1500)}${markdownSummary.length > 1500 ? "\n...[truncated]" : ""}

Generate a structured JSON task list for the migration. Migration target: migrate/

RULES:
- Return ONLY a valid JSON array — no markdown, no explanation
- Every task: id (task-001…), title, type (build|config|code|resource), files[], dependsOn[], description
- Order: build tasks first, then config, then code, then resource
- No circular dependencies in dependsOn
- Files must be paths under migrate/
- Cover ALL controllers, services, repositories, XML configs identified above
- MUST include tasks for every Spring artifact listed in "SPRING ARTIFACTS requiring dedicated tasks" above

\`\`\`json
[
  {
    "id": "task-001",
    "title": "Create Spring Boot main application class",
    "type": "build",
    "files": ["migrate/src/main/java/com/example/Application.java"],
    "dependsOn": [],
    "description": "Create @SpringBootApplication entry point"
  }
]
\`\`\`

Return ONLY the JSON array inside a \`\`\`json block.`;
  }

  static getMigrationDocumentInstructions(): string {
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

  static categorizeSpringBuildError(message: string): string {
    const msg = message.toLowerCase();
    if (msg.includes("cannot find symbol") || msg.includes("symbol not found") || msg.includes("does not exist")) return "MISSING_IMPORT_OR_SYMBOL";
    if (msg.includes("duplicate bean") || msg.includes("expected single matching bean") || msg.includes("no qualifying bean")) return "SPRING_BEAN_ERROR";
    if (msg.includes("circular") && msg.includes("dependency")) return "CIRCULAR_DEPENDENCY";
    if (msg.includes("unsatisfied dependency") || msg.includes("no bean named")) return "MISSING_BEAN_DEFINITION";
    if (msg.includes("javax") && (msg.includes("jakarta") || msg.includes("class not found"))) return "JAVAX_JAKARTA_MIGRATION";
    if (msg.includes("is not abstract and does not override abstract method")) return "INTERFACE_MISSING_METHOD";
    if (msg.includes("@enablewebmvc") || msg.includes("conflicting") && msg.includes("mvc")) return "ENABLE_WEB_MVC_CONFLICT";
    if (msg.includes("datasource") || msg.includes("connection refused") || msg.includes("jdbcurl")) return "DATASOURCE_CONFIG";
    if (msg.includes("deprecated") || msg.includes("has been removed")) return "DEPRECATED_API";
    if (msg.includes("nullpointerexception") || msg.includes("application context")) return "CONTEXT_INITIALIZATION";
    return "COMPILATION_ERROR";
  }

  static buildRepairPrompt(
    buildErrors: BuildError[],
    affectedFiles: string[],
    attemptNumber: number
  ): string {
    const categorized = buildErrors.map((err) => ({
      ...err,
      category: PromptBuilder.categorizeSpringBuildError(err.message),
    }));

    const errorSummary = categorized
      .map((err) => `- [${err.category}] ${err.file || "unknown"}:${err.line || "?"} — ${err.message}`)
      .join("\n");

    const uniqueCategories = [...new Set(categorized.map((e) => e.category))];

    const repairHints: string[] = [];
    if (uniqueCategories.includes("JAVAX_JAKARTA_MIGRATION")) {
      repairHints.push("JAVAX→JAKARTA: Replace all 'javax.servlet.*' with 'jakarta.servlet.*', 'javax.persistence.*' with 'jakarta.persistence.*', 'javax.validation.*' with 'jakarta.validation.*'");
    }
    if (uniqueCategories.includes("SPRING_BEAN_ERROR")) {
      repairHints.push("BEAN ERROR: Check for duplicate @Bean method names across @Configuration classes. Use @Primary to disambiguate. Check @Qualifier usages match bean names.");
    }
    if (uniqueCategories.includes("MISSING_BEAN_DEFINITION")) {
      repairHints.push("MISSING BEAN: Add missing @Component/@Service/@Repository stereotype or @Bean method in a @Configuration class. Verify @ComponentScan covers the package.");
    }
    if (uniqueCategories.includes("CIRCULAR_DEPENDENCY")) {
      repairHints.push("CIRCULAR DEP: Break the cycle by introducing @Lazy on one injection point, or extract a shared interface/service.");
    }
    if (uniqueCategories.includes("ENABLE_WEB_MVC_CONFLICT")) {
      repairHints.push("MVC CONFLICT: Remove @EnableWebMvc from @SpringBootApplication class — it disables Boot auto-config. Move any WebMvcConfigurer to a separate @Configuration class without @EnableWebMvc.");
    }
    if (uniqueCategories.includes("DATASOURCE_CONFIG")) {
      repairHints.push("DATASOURCE: Ensure application.properties has spring.datasource.url, spring.datasource.username, spring.datasource.password. Remove manual DataSource @Bean if using auto-config.");
    }
    if (uniqueCategories.includes("DEPRECATED_API")) {
      repairHints.push("DEPRECATED API: WebMvcConfigurerAdapter → implement WebMvcConfigurer. SimpleFormController → @Controller. XmlBeanFactory → removed, use AnnotationConfigApplicationContext.");
    }
    if (uniqueCategories.includes("INTERFACE_MISSING_METHOD")) {
      repairHints.push("MISSING METHOD: Implement all abstract methods from implemented interfaces. Check if Spring interface changed between versions.");
    }

    return `You are a senior Spring Boot engineer fixing build errors after a Spring MVC → Spring Boot migration.

ATTEMPT: ${attemptNumber}/5
ERROR CATEGORIES: ${uniqueCategories.join(", ")}

BUILD ERRORS (categorized):
${errorSummary}

AFFECTED FILES:
${affectedFiles.join("\n")}

${repairHints.length > 0 ? `SPRING-SPECIFIC REPAIR GUIDANCE:\n${repairHints.map((h) => `  → ${h}`).join("\n")}\n` : ""}
RULES:
1. Return ONLY valid JSON — no markdown, no explanation
2. Each fix must specify: file, action, content, reasoning
3. Fix COMPILATION errors first, then CONTEXT initialization errors
4. Provide COMPLETE file content, never partial diffs
5. NEVER use field injection — always constructor injection
6. NEVER reference XML config files in Java code
7. NEVER add @EnableWebMvc to @SpringBootApplication class
8. ALWAYS use jakarta.* imports for Spring Boot 3.x

Return JSON in this format:
{
  "success": true,
  "fixes": [
    {
      "file": "migrate/path/to/File.java",
      "action": "modify",
      "content": "complete corrected file content"
    }
  ],
  "reasoning": "explanation of what was wrong and how it was fixed"
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

  static buildVerifierSystemPrompt(): string {
    return `You are a principal-level Java architect and code migration auditor.

Your task is to rigorously review a generated Spring MVC → Spring Boot migration plan.

You must NOT assume the plan is correct.

You must:
- Identify missing steps
- Detect incorrect or risky migration strategies
- Validate completeness of the migration
- Validate task dependencies and execution order
- Ensure alignment with Spring Boot best practices

Be critical, precise, and exhaustive.
Do not provide generic feedback.
Score each dimension honestly — do not inflate scores.`;
  }

  static buildMigrationVerificationPrompt(
    intelligence: CodebaseIntelligence,
    markdownContent: string,
    plan: MigrationPlan
  ): string {
    const sa = intelligence.springArtifacts;
    const artifactLines: string[] = [];
    if (sa) {
      const base = (f: string) => f.split("/").pop() ?? f;
      if (sa.filters.length) artifactLines.push(`Filters: ${sa.filters.map(base).join(", ")}`);
      if (sa.interceptors.length) artifactLines.push(`Interceptors: ${sa.interceptors.map(base).join(", ")}`);
      if (sa.aspects.length) artifactLines.push(`AOP Aspects: ${sa.aspects.map(base).join(", ")}`);
      if (sa.exceptionHandlers.length) artifactLines.push(`Exception Handlers: ${sa.exceptionHandlers.map(base).join(", ")}`);
      if (sa.scheduledTasks.length) artifactLines.push(`Scheduled Tasks: ${sa.scheduledTasks.map(base).join(", ")}`);
      if (sa.converters.length) artifactLines.push(`Converters: ${sa.converters.map(base).join(", ")}`);
      if (sa.validators.length) artifactLines.push(`Validators: ${sa.validators.map(base).join(", ")}`);
    }

    const contextSummary = [
      `Framework: ${intelligence.framework}`,
      `Build Tool: ${intelligence.buildTool}`,
      `Controllers: ${intelligence.stats.controllers}`,
      `Services: ${intelligence.stats.services}`,
      `Repositories: ${intelligence.stats.repositories}`,
      `XML Config Files: ${intelligence.stats.xmlConfigFiles}`,
      `Total Files: ${intelligence.stats.totalFiles}`,
      `Circular Dependencies: ${intelligence.graphSummary.circularDependencies}`,
      `usesXmlConfiguration: ${intelligence.patterns.usesXmlConfiguration}`,
      `usesFieldInjection: ${intelligence.patterns.usesFieldInjection}`,
      `hasLegacyDispatcher: ${intelligence.patterns.hasLegacyDispatcher}`,
      `missingBootMain: ${intelligence.patterns.missingBootMain}`,
      `hasMultipleXmlConfigs: ${intelligence.patterns.hasMultipleXmlConfigs}`,
      `usesPropertyPlaceholders: ${intelligence.patterns.usesPropertyPlaceholders}`,
      `hasCircularDependencies: ${intelligence.patterns.hasCircularDependencies}`,
      `Controllers: ${intelligence.keyFiles.controllers.slice(0, 10).join(", ") || "(none)"}`,
      `Services: ${intelligence.keyFiles.services.slice(0, 10).join(", ") || "(none)"}`,
      `Configs: ${intelligence.keyFiles.configs.slice(0, 10).join(", ") || "(none)"}`,
      `Entry Points: ${intelligence.keyFiles.entryPoints.join(", ") || "(none)"}`,
      artifactLines.length ? `\nSPRING ARTIFACTS (verify each has a dedicated migration task):\n${artifactLines.join("\n")}` : null,
    ].filter(Boolean).join("\n");

    const tasksJson = JSON.stringify(plan.tasks, null, 2);

    return `You are given:

1) Project Analysis (structured codebase intelligence)
2) Generated Migration Document (markdown)
3) Generated Task Plan (JSON)

Your job is to VERIFY the migration quality.

---

### Project Analysis:
${contextSummary}

---

### Migration Document (first 6000 chars):
${markdownContent.slice(0, 6000)}${markdownContent.length > 6000 ? "\n...[truncated]" : ""}

---

### Task Plan (JSON):
${tasksJson.slice(0, 4000)}${tasksJson.length > 4000 ? "\n...[truncated]" : ""}

---

### Perform the following checks:

#### 1. COMPLETENESS CHECK
- Are all major migration areas covered?
  - XML → Java Config
  - Dependency Injection changes
  - Entry point creation (@SpringBootApplication)
  - Build file updates (Spring Boot dependencies)
  - Configuration migration (properties/yml)
  - Controller/service/repository updates
  - Every Spring Artifact listed above has a dedicated task

List missing areas.

#### 2. TASK COVERAGE CHECK
- Do tasks cover ALL identified components from the Project Analysis?
- Are any files/components from the analysis missing from tasks?
- Are config files properly included?

#### 3. DEPENDENCY VALIDATION
- Are task dependencies logically correct?
- Is execution order valid (build → config → code → resource)?
- Are there circular or missing dependencies?

#### 4. TECHNICAL CORRECTNESS
- Are migration strategies correct for Spring Boot?
- Any outdated or incorrect practices?
- Any risky transformations (e.g., incorrect bean replacements, missing annotations)?

#### 5. CONSISTENCY CHECK
- Do markdown and task plan agree on what needs to be done?
- Any contradictions between them?

#### 6. RISK ANALYSIS
- Identify high-risk areas:
  - complex XML configs not fully handled
  - tight coupling
  - missing bean definitions
  - circular dependencies not resolved

#### 7. IMPROVEMENT SUGGESTIONS
- Suggest better migration approaches if applicable

---

### OUTPUT FORMAT (STRICT JSON — return ONLY this, no extra text):

\`\`\`json
{
  "status": "PASS",
  "summary": "Short overall assessment",
  "scores": {
    "completeness": 8,
    "correctness": 7,
    "executability": 9
  },
  "missingItems": [
    "..."
  ],
  "taskIssues": [
    {
      "taskId": "task-001",
      "issue": "..."
    }
  ],
  "dependencyIssues": [
    "..."
  ],
  "technicalIssues": [
    "..."
  ],
  "consistencyIssues": [
    "..."
  ],
  "risks": [
    "..."
  ],
  "improvements": [
    "..."
  ]
}
\`\`\``;
  }

  static buildMigrationFixPrompt(
    intelligence: CodebaseIntelligence,
    markdownContent: string,
    plan: MigrationPlan,
    verificationResult: MigrationPlanVerificationResult
  ): string {
    const issuesSummary = [
      verificationResult.missingItems.length > 0
        ? `MISSING ITEMS:\n${verificationResult.missingItems.map((i) => `- ${i}`).join("\n")}`
        : null,
      verificationResult.taskIssues.length > 0
        ? `TASK ISSUES:\n${verificationResult.taskIssues.map((i) => `- [${i.taskId}] ${i.issue}`).join("\n")}`
        : null,
      verificationResult.dependencyIssues.length > 0
        ? `DEPENDENCY ISSUES:\n${verificationResult.dependencyIssues.map((i) => `- ${i}`).join("\n")}`
        : null,
      verificationResult.technicalIssues.length > 0
        ? `TECHNICAL ISSUES:\n${verificationResult.technicalIssues.map((i) => `- ${i}`).join("\n")}`
        : null,
      verificationResult.consistencyIssues.length > 0
        ? `CONSISTENCY ISSUES:\n${verificationResult.consistencyIssues.map((i) => `- ${i}`).join("\n")}`
        : null,
      verificationResult.risks.length > 0
        ? `RISKS:\n${verificationResult.risks.map((i) => `- ${i}`).join("\n")}`
        : null,
      verificationResult.improvements.length > 0
        ? `SUGGESTED IMPROVEMENTS:\n${verificationResult.improvements.map((i) => `- ${i}`).join("\n")}`
        : null,
    ]
      .filter(Boolean)
      .join("\n\n");

    const contextSummary = [
      `Framework: ${intelligence.framework}`,
      `Build Tool: ${intelligence.buildTool}`,
      `Controllers: ${intelligence.stats.controllers}`,
      `Services: ${intelligence.stats.services}`,
      `Repositories: ${intelligence.stats.repositories}`,
      `XML Config Files: ${intelligence.stats.xmlConfigFiles}`,
      `Detected Patterns — usesXmlConfiguration: ${intelligence.patterns.usesXmlConfiguration}, usesFieldInjection: ${intelligence.patterns.usesFieldInjection}, hasLegacyDispatcher: ${intelligence.patterns.hasLegacyDispatcher}, missingBootMain: ${intelligence.patterns.missingBootMain}`,
    ].join("\n");

    return `You are a senior Spring migration architect.

A verification audit was run on a generated migration plan and FAILED with the following issues:

---

### Verification Report
Status: ${verificationResult.status}
Summary: ${verificationResult.summary}
Scores: completeness=${verificationResult.scores.completeness}/10, correctness=${verificationResult.scores.correctness}/10, executability=${verificationResult.scores.executability}/10

${issuesSummary}

---

### Project Context:
${contextSummary}

---

### Original Migration Document (first 4000 chars):
${markdownContent.slice(0, 4000)}${markdownContent.length > 4000 ? "\n...[truncated]" : ""}

---

### Original Task Plan:
${JSON.stringify(plan.tasks.slice(0, 30), null, 2)}

---

### YOUR TASK:
Fix the migration plan based on all identified issues.

RULES:
1. Address every issue listed in the verification report
2. Add missing tasks for uncovered components
3. Fix incorrect dependency ordering
4. Apply correct Spring Boot patterns
5. Ensure all XML configs are properly converted in the task list
6. Return the SAME dual-output format as the original generation

${PromptBuilder.getMigrationDocumentInstructions()}`;
  }

}

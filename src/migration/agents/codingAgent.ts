import type { MigrationTask, FileOperation } from "../types/migrationTypes";
import { LLMClient } from "../llm/llmClient";
import { PromptBuilder } from "../llm/promptBuilder";
import type { MigrationState } from "../core/migrationState";
import { serializeGlobalDecisions } from "../core/migrationState";
import { createScopedLogger } from "../../utils/logger";

const logger = createScopedLogger("coding-agent");

export interface TaskExecutionContext {
  state: MigrationState;
  dependencyContents: Map<string, string>;
  markdownGuidance?: string;
}

export class CodingAgent {
  constructor(private llmClient: LLMClient) {}

  async processTask(
    task: MigrationTask,
    currentContent?: string
  ): Promise<FileOperation> {
    logger.info(`Processing task: ${task.action} ${task.file}`);

    if (task.action === "delete") {
      return {
        file: task.file,
        action: "delete",
        previousContent: currentContent,
      };
    }

    if (task.action === "create" || task.action === "modify") {
      const prompt = PromptBuilder.buildCodingPrompt(
        task.file,
        task.action,
        task.description,
        currentContent
      );

      const response = await this.llmClient.generateText(prompt, {
        maxRetries: 2,
        systemPrompt: "You are a senior software engineer. Generate clean, production-ready code.",
      });

      if (!response.success || !response.data) {
        throw new Error(`Failed to generate code for ${task.file}: ${response.error}`);
      }

      const content = this.cleanGeneratedCode(response.data);

      return {
        file: task.file,
        action: task.action,
        content,
        previousContent: currentContent,
      };
    }

    throw new Error(`Unsupported action: ${task.action}`);
  }

  async processTaskWithContext(
    task: MigrationTask,
    ctx: TaskExecutionContext
  ): Promise<FileOperation> {
    logger.info(`Processing task with context: ${task.action} ${task.file} [type=${task.type ?? "code"}]`);

    if (task.action === "delete") {
      return {
        file: task.file,
        action: "delete",
        previousContent: ctx.state.fileMap.get(task.file),
      };
    }

    const currentContent = ctx.state.fileMap.get(task.file);

    const prompt = this.buildContextAwarePrompt(task, ctx, currentContent);

    const response = await this.llmClient.generateText(prompt, {
      maxRetries: 2,
      systemPrompt:
        "You are a senior Spring Boot migration engineer. Generate production-ready, compilable Java code. Use constructor injection exclusively. Follow Spring Boot best practices.",
    });

    if (!response.success || !response.data) {
      throw new Error(`Failed to generate code for ${task.file}: ${response.error}`);
    }

    const content = this.cleanGeneratedCode(response.data);

    return {
      file: task.file,
      action: task.action ?? "create",
      content,
      previousContent: currentContent,
    };
  }

  private buildContextAwarePrompt(
    task: MigrationTask,
    ctx: TaskExecutionContext,
    currentContent: string | undefined
  ): string {
    const sections: string[] = [];

    sections.push(`You are migrating a Spring MVC project to Spring Boot.`);
    sections.push(`\n## TASK`);
    sections.push(`File: ${task.file}`);
    sections.push(`Action: ${task.action ?? "create"}`);
    sections.push(`Type: ${task.type ?? "code"}`);
    sections.push(`Description: ${task.description}`);

    if (task.files && task.files.length > 1) {
      sections.push(`\nRelated files in this task: ${task.files.join(", ")}`);
    }

    sections.push(`\n## MIGRATION STATE`);
    sections.push(serializeGlobalDecisions(ctx.state));

    if (ctx.dependencyContents.size > 0) {
      sections.push(`\n## DEPENDENCY FILES (classes this file depends on)`);
      for (const [path, content] of ctx.dependencyContents) {
        sections.push(`\n### ${path}`);
        sections.push("```java");
        sections.push(content.slice(0, 1200) + (content.length > 1200 ? "\n...[truncated]" : ""));
        sections.push("```");
      }
    }

    if (currentContent) {
      sections.push(`\n## CURRENT FILE CONTENT (before migration)`);
      sections.push("```java");
      sections.push(currentContent.slice(0, 2000) + (currentContent.length > 2000 ? "\n...[truncated]" : ""));
      sections.push("```");
    }

    if (ctx.markdownGuidance) {
      sections.push(`\n## MIGRATION GUIDANCE (from Migration.md)`);
      sections.push(ctx.markdownGuidance.slice(0, 1500));
    }

    sections.push(`\n## RULES (MANDATORY)`);
    sections.push(`1. Use CONSTRUCTOR INJECTION ONLY — no @Autowired on fields`);
    sections.push(`2. Remove ALL XML references`);
    sections.push(`3. Add correct stereotype: @Service, @Repository, @Controller, @RestController, @Configuration`);
    sections.push(`4. Do NOT duplicate beans already registered in: ${Array.from(ctx.state.globalDecisions.beanNames.keys()).join(", ") || "(none yet)"}`);
    sections.push(`5. Preserve 100% of business logic`);
    sections.push(`6. Ensure the file compiles standalone`);
    sections.push(`7. Return ONLY the complete file content — no markdown blocks, no explanations`);

    this.appendStageSpecificRules(sections, task.type ?? "code");

    return sections.join("\n");
  }

  private appendStageSpecificRules(sections: string[], type: string): void {
    switch (type) {
      case "build":
        sections.push(`\n## BUILD-SPECIFIC RULES`);
        sections.push(`- Use spring-boot-starter-parent as parent POM`);
        sections.push(`- Include spring-boot-starter-web, spring-boot-starter-data-jpa (if needed)`);
        sections.push(`- Add spring-boot-maven-plugin`);
        sections.push(`- Remove servlet-api, spring-webmvc standalone dependencies (covered by starters)`);
        break;

      case "config":
        sections.push(`\n## CONFIG-SPECIFIC RULES`);
        sections.push(`- Annotate with @Configuration`);
        sections.push(`- Replace every <bean> with a @Bean method`);
        sections.push(`- Replace context:component-scan with @SpringBootApplication or @ComponentScan`);
        sections.push(`- Replace property-placeholder with @Value or @ConfigurationProperties`);
        sections.push(`- If this replaces web.xml: create @SpringBootApplication main class instead`);
        break;

      case "code":
        sections.push(`\n## CODE-SPECIFIC RULES`);
        sections.push(`- Add @Service / @Repository / @Controller / @RestController as appropriate`);
        sections.push(`- Convert field injection to constructor injection`);
        sections.push(`- Remove any Spring XML configuration references`);
        sections.push(`- Keep all business logic intact`);
        break;

      case "resource":
        sections.push(`\n## RESOURCE-SPECIFIC RULES`);
        sections.push(`- Place in src/main/resources/`);
        sections.push(`- application.properties: use Spring Boot property keys`);
        sections.push(`- Remove legacy servlet/container config`);
        break;
    }
  }

  cleanGeneratedCode(code: string): string {
    let cleaned = code.trim();

    if (cleaned.startsWith("```")) {
      const lines = cleaned.split("\n");
      lines.shift();
      if (lines[lines.length - 1].trim() === "```") {
        lines.pop();
      }
      cleaned = lines.join("\n");
    }

    cleaned = cleaned.trim();
    return cleaned;
  }

  async batchProcessTasks(
    tasks: MigrationTask[],
    fileContents: Map<string, string>
  ): Promise<FileOperation[]> {
    logger.info(`Batch processing ${tasks.length} tasks`);

    const operations: FileOperation[] = [];

    for (const task of tasks) {
      try {
        const currentContent = fileContents.get(task.file);
        const operation = await this.processTask(task, currentContent);
        operations.push(operation);
      } catch (error) {
        logger.error(`Failed to process task for ${task.file}: ${(error as Error).message}`);
        throw error;
      }
    }

    logger.info(`Batch processing complete: ${operations.length} operations`);
    return operations;
  }
}

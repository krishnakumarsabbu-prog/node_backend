import type { FileMap } from "../../llm/constants";
import type { ProjectAnalysis } from "../types/migrationTypes";
import { extractFileSummaries, serializeFileSummary, type FileSummary } from "./semanticExtractor";
import { buildDependencyGraph, serializeDependencyGraph, type DependencyGraph } from "./dependencyGraph";
import { parseXmlConfigs, serializeAllXmlSummaries, type XmlFileSummary } from "./xmlConfigParser";
import { analyzeBuildFile, serializeBuildSummary, type BuildFileSummary } from "./dependencyAnalyzer";
import { createScopedLogger } from "../../utils/logger";

const logger = createScopedLogger("context-builder");

export type MigrationPattern =
  | "xml-to-annotation"
  | "add-spring-boot-main"
  | "remove-web-xml"
  | "convert-xml-beans"
  | "add-application-properties"
  | "update-build-file"
  | "convert-security-xml"
  | "convert-persistence-xml";

export interface CodebaseIntelligence {
  framework: string;
  buildTool: string;
  totalFiles: number;
  sourceFiles: number;

  fileSummaries: FileSummary[];
  dependencyGraph: DependencyGraph;
  xmlConfigs: XmlFileSummary[];
  buildSummary: BuildFileSummary;

  detectedPatterns: MigrationPattern[];

  entryPoints: string[];
  configFiles: string[];
  controllers: string[];
  services: string[];
  repositories: string[];
  models: string[];

  serialized: {
    fileSummaries: string;
    dependencyGraph: string;
    xmlConfigs: string;
    buildSummary: string;
    patterns: string;
  };
}

function detectMigrationPatterns(
  xmlConfigs: XmlFileSummary[],
  buildSummary: BuildFileSummary,
  fileSummaries: FileSummary[]
): MigrationPattern[] {
  const patterns: MigrationPattern[] = [];

  if (xmlConfigs.some((x) => x.xmlType === "web-xml")) {
    patterns.push("remove-web-xml");
    patterns.push("add-spring-boot-main");
  }

  if (xmlConfigs.some((x) => x.beanCount > 0)) {
    patterns.push("xml-to-annotation");
    patterns.push("convert-xml-beans");
  }

  if (!buildSummary.hasSpringBootParent || !buildSummary.hasSpringBootPlugin) {
    patterns.push("update-build-file");
  }

  if (!fileSummaries.some((f) => f.path.match(/application\.(properties|yml|yaml)$/))) {
    patterns.push("add-application-properties");
  }

  if (xmlConfigs.some((x) => x.securityConfig)) {
    patterns.push("convert-security-xml");
  }

  if (xmlConfigs.some((x) => x.dataSource || x.transactionManager)) {
    patterns.push("convert-persistence-xml");
  }

  return patterns;
}

function serializePatterns(patterns: MigrationPattern[]): string {
  if (patterns.length === 0) return "(no specific migration patterns detected)";

  const descriptions: Record<MigrationPattern, string> = {
    "xml-to-annotation": "Convert XML-based configuration to Java @Configuration annotations",
    "add-spring-boot-main": "Create @SpringBootApplication main class",
    "remove-web-xml": "Remove web.xml → replace with embedded Tomcat via Spring Boot",
    "convert-xml-beans": "Convert <bean> definitions to @Component / @Service / @Repository / @Bean",
    "add-application-properties": "Create application.properties with Spring Boot config keys",
    "update-build-file": "Update pom.xml/build.gradle to use spring-boot-starter-parent + plugins",
    "convert-security-xml": "Convert Spring Security XML to SecurityFilterChain @Bean",
    "convert-persistence-xml": "Convert persistence/datasource XML to application.properties + @EnableJpaRepositories",
  };

  return patterns.map((p) => `  → [${p}] ${descriptions[p]}`).join("\n");
}

export function buildCodebaseIntelligence(files: FileMap, analysis: ProjectAnalysis): CodebaseIntelligence {
  logger.info("Building codebase intelligence layer...");

  const fileSummaries = extractFileSummaries(files);
  logger.info(`Extracted ${fileSummaries.length} file summaries`);

  const dependencyGraph = buildDependencyGraph(fileSummaries);
  logger.info(`Built dependency graph: ${dependencyGraph.nodes.length} nodes, ${dependencyGraph.edges.length} edges`);

  const xmlConfigs = parseXmlConfigs(files);
  logger.info(`Parsed ${xmlConfigs.length} XML config files`);

  const buildSummary = analyzeBuildFile(files);
  logger.info(`Analyzed build file: type=${buildSummary.type}`);

  const detectedPatterns = detectMigrationPatterns(xmlConfigs, buildSummary, fileSummaries);
  logger.info(`Detected ${detectedPatterns.length} migration patterns: ${detectedPatterns.join(", ")}`);

  const byRole = (role: string) => fileSummaries.filter((f) => f.role === role).map((f) => f.path);

  const intelligence: CodebaseIntelligence = {
    framework: analysis.framework,
    buildTool: analysis.buildTool,
    totalFiles: Object.keys(files).length,
    sourceFiles: fileSummaries.length,

    fileSummaries,
    dependencyGraph,
    xmlConfigs,
    buildSummary,
    detectedPatterns,

    entryPoints: byRole("entry"),
    configFiles: byRole("config"),
    controllers: byRole("controller"),
    services: byRole("service"),
    repositories: byRole("repository"),
    models: byRole("model"),

    serialized: {
      fileSummaries: fileSummaries.map(serializeFileSummary).join("\n\n"),
      dependencyGraph: serializeDependencyGraph(dependencyGraph),
      xmlConfigs: serializeAllXmlSummaries(xmlConfigs),
      buildSummary: serializeBuildSummary(buildSummary),
      patterns: serializePatterns(detectedPatterns),
    },
  };

  return intelligence;
}

export function buildMigrationContextPrompt(intelligence: CodebaseIntelligence, userRequest: string): string {
  const sections: string[] = [];

  sections.push(`FRAMEWORK: ${intelligence.framework}`);
  sections.push(`BUILD TOOL: ${intelligence.buildTool}`);
  sections.push(`TOTAL FILES: ${intelligence.totalFiles} (${intelligence.sourceFiles} source files analyzed)`);

  sections.push(`\n## ARCHITECTURE OVERVIEW`);
  sections.push(`Controllers (${intelligence.controllers.length}): ${intelligence.controllers.slice(0, 10).join(", ")}`);
  sections.push(`Services (${intelligence.services.length}): ${intelligence.services.slice(0, 10).join(", ")}`);
  sections.push(`Repositories (${intelligence.repositories.length}): ${intelligence.repositories.slice(0, 10).join(", ")}`);
  sections.push(`Models (${intelligence.models.length}): ${intelligence.models.slice(0, 10).join(", ")}`);
  sections.push(`Config Files (${intelligence.configFiles.length}): ${intelligence.configFiles.slice(0, 10).join(", ")}`);
  sections.push(`Entry Points: ${intelligence.entryPoints.join(", ") || "(none detected)"}`);

  sections.push(`\n## BUILD FILE ANALYSIS`);
  sections.push(intelligence.serialized.buildSummary);

  sections.push(`\n## XML CONFIGURATION ANALYSIS`);
  sections.push(intelligence.serialized.xmlConfigs);

  sections.push(`\n## DEPENDENCY GRAPH`);
  sections.push(intelligence.serialized.dependencyGraph);

  sections.push(`\n## SEMANTIC FILE SUMMARIES`);
  const prioritizedSummaries = [
    ...intelligence.fileSummaries.filter((f) => f.role === "entry"),
    ...intelligence.fileSummaries.filter((f) => f.role === "config"),
    ...intelligence.fileSummaries.filter((f) => f.role === "controller"),
    ...intelligence.fileSummaries.filter((f) => f.role === "service"),
    ...intelligence.fileSummaries.filter((f) => f.role === "repository"),
    ...intelligence.fileSummaries.filter((f) => f.role === "model"),
    ...intelligence.fileSummaries.filter((f) => f.role === "other"),
  ].slice(0, 80);

  sections.push(prioritizedSummaries.map(serializeFileSummary).join("\n\n"));

  sections.push(`\n## DETECTED MIGRATION PATTERNS`);
  sections.push(intelligence.serialized.patterns);

  sections.push(`\n## USER REQUEST`);
  sections.push(userRequest);

  return sections.join("\n");
}

export function buildStepContext(
  intelligence: CodebaseIntelligence,
  stepHeading: string,
  stepDetails: string,
  files: FileMap
): string {
  const relevantFiles = findRelevantFiles(intelligence, stepHeading + " " + stepDetails);
  const lines: string[] = [];

  lines.push(`STEP: ${stepHeading}`);
  lines.push(`DETAILS: ${stepDetails}`);
  lines.push("");
  lines.push(`RELEVANT SOURCE FILES (${relevantFiles.length}):`);

  for (const path of relevantFiles.slice(0, 12)) {
    const entry = files[path];
    if (!entry || !(entry as any).content) continue;
    const content = (entry as any).content as string;
    const summary = intelligence.fileSummaries.find((s) => s.path === path);
    if (summary) {
      lines.push(`\n### ${path} [${summary.role.toUpperCase()}]`);
      lines.push(`Annotations: @${summary.annotations.join(", @") || "none"}`);
      lines.push(`Classes: ${summary.classNames.join(", ") || "none"}`);
      lines.push(`Methods: ${summary.methods.slice(0, 5).map((m) => m.name).join(", ")}`);
      lines.push("```");
      lines.push(content.slice(0, 1500) + (content.length > 1500 ? "\n...[truncated]" : ""));
      lines.push("```");
    }
  }

  const xmlRelevant = intelligence.xmlConfigs.filter((x) =>
    stepHeading.toLowerCase().includes("config") ||
    stepHeading.toLowerCase().includes("xml") ||
    stepHeading.toLowerCase().includes("setup") ||
    stepDetails.toLowerCase().includes(x.file.split("/").pop()?.toLowerCase() || "")
  );

  if (xmlRelevant.length > 0) {
    lines.push("\nRELEVANT XML CONFIGS:");
    for (const xml of xmlRelevant) {
      lines.push(`\n### ${xml.file} [${xml.xmlType.toUpperCase()}]`);
      lines.push(`Beans: ${xml.beanCount}, Features: ${[xml.componentScan && "component-scan", xml.viewResolver && "ViewResolver", xml.dataSource && "DataSource"].filter(Boolean).join(", ")}`);
      lines.push("```xml");
      lines.push(xml.rawSnippet + (xml.rawSnippet.length >= 600 ? "\n...[truncated]" : ""));
      lines.push("```");
    }
  }

  return lines.join("\n");
}

function findRelevantFiles(intelligence: CodebaseIntelligence, query: string): string[] {
  const queryLower = query.toLowerCase();
  const scored: Array<{ path: string; score: number }> = [];

  const queryTerms = queryLower.split(/\s+/).filter((t) => t.length > 3);

  for (const summary of intelligence.fileSummaries) {
    if (summary.role === "test") continue;

    let score = 0;

    const pathLower = summary.path.toLowerCase();
    for (const term of queryTerms) {
      if (pathLower.includes(term)) score += 3;
    }

    for (const term of queryTerms) {
      if (summary.classNames.some((c) => c.toLowerCase().includes(term))) score += 5;
      if (summary.annotations.some((a) => a.toLowerCase().includes(term))) score += 4;
      if (summary.methods.some((m) => m.name.toLowerCase().includes(term))) score += 2;
    }

    if (summary.role === "controller" && queryLower.includes("controller")) score += 10;
    if (summary.role === "service" && queryLower.includes("service")) score += 10;
    if (summary.role === "config" && (queryLower.includes("config") || queryLower.includes("setup"))) score += 10;
    if (summary.role === "entry" && (queryLower.includes("main") || queryLower.includes("application") || queryLower.includes("setup"))) score += 10;

    if (score > 0) scored.push({ path: summary.path, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 15).map((s) => s.path);
}

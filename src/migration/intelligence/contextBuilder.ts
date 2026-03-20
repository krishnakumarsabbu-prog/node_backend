import type { FileMap } from "../../llm/constants";
import type { ProjectAnalysis, DetectedPatterns } from "../types/migrationTypes";
import { extractFileSummaries, serializeFileSummary, type FileSummary } from "./semanticExtractor";
import { buildDependencyGraph, serializeDependencyGraph, type DependencyGraph, type GraphSummary } from "./dependencyGraph";
import { parseXmlConfigs, serializeAllXmlSummaries, type XmlFileSummary } from "./xmlConfigParser";
import { analyzeBuildFile, serializeBuildSummary, type BuildFileSummary } from "./dependencyAnalyzer";
import { buildIR, serializeIR } from "../ir/irBuilder";
import type { IrProjectModel } from "../ir/irTypes";
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

export interface ProjectStats {
  totalFiles: number;
  sourceFiles: number;
  controllers: number;
  services: number;
  repositories: number;
  models: number;
  configFiles: number;
  xmlConfigFiles: number;
  testFiles: number;
}

export interface KeyFiles {
  controllers: string[];
  services: string[];
  repositories: string[];
  configs: string[];
  entryPoints: string[];
  models: string[];
}

export interface CodebaseIntelligence {
  framework: string;
  buildTool: string;

  stats: ProjectStats;
  patterns: DetectedPatterns;
  graphSummary: GraphSummary;
  keyFiles: KeyFiles;

  fileSummaries: FileSummary[];
  dependencyGraph: DependencyGraph;
  xmlConfigs: XmlFileSummary[];
  buildSummary: BuildFileSummary;
  buildConfig?: { hasBootParent: boolean; hasBootPlugin: boolean };

  migrationPatterns: MigrationPattern[];

  ir: IrProjectModel;

  serialized: {
    fileSummaries: string;
    dependencyGraph: string;
    xmlConfigs: string;
    buildSummary: string;
    patterns: string;
    detectedPatterns: string;
    ir: string;
  };
}

function computeDetectedPatterns(
  fileSummaries: FileSummary[],
  xmlConfigs: XmlFileSummary[],
  buildSummary: BuildFileSummary,
  graphSummary: GraphSummary
): DetectedPatterns {
  const hasWebXml = xmlConfigs.some((x) => x.xmlType === "web-xml");
  const hasDispatcherServlet = xmlConfigs.some((x) => x.dispatcherServlet) ||
    fileSummaries.some((f) => f.hasDispatcherServletRef);
  const hasSpringBootMain = fileSummaries.some((f) => f.isSpringBootMain) ||
    buildSummary.hasSpringBootParent;
  const usesFieldInjection = fileSummaries.some((f) => f.usesFieldInjection);
  const hasXmlBeans = xmlConfigs.some((x) => x.beanCount > 0);
  const hasPropertyPlaceholders = xmlConfigs.some((x) => x.propertyPlaceholder);

  return {
    usesXmlConfiguration: hasWebXml || hasXmlBeans || xmlConfigs.length > 0,
    usesFieldInjection,
    hasLegacyDispatcher: hasWebXml || hasDispatcherServlet,
    missingBootMain: !hasSpringBootMain,
    hasMultipleXmlConfigs: xmlConfigs.length > 1,
    usesPropertyPlaceholders: hasPropertyPlaceholders,
    hasCircularDependencies: graphSummary.circularDependencies > 0,
  };
}

function detectMigrationPatterns(
  xmlConfigs: XmlFileSummary[],
  buildSummary: BuildFileSummary,
  fileSummaries: FileSummary[],
  patterns: DetectedPatterns
): MigrationPattern[] {
  const result: MigrationPattern[] = [];

  if (patterns.hasLegacyDispatcher || xmlConfigs.some((x) => x.xmlType === "web-xml")) {
    result.push("remove-web-xml");
  }

  if (patterns.missingBootMain) {
    result.push("add-spring-boot-main");
  }

  if (patterns.usesXmlConfiguration) {
    result.push("xml-to-annotation");
    if (xmlConfigs.some((x) => x.beanCount > 0)) result.push("convert-xml-beans");
  }

  if (!buildSummary.hasSpringBootParent || !buildSummary.hasSpringBootPlugin) {
    result.push("update-build-file");
  }

  if (!fileSummaries.some((f) => f.path.match(/application\.(properties|yml|yaml)$/))) {
    result.push("add-application-properties");
  }

  if (xmlConfigs.some((x) => x.securityConfig)) {
    result.push("convert-security-xml");
  }

  if (xmlConfigs.some((x) => x.dataSource || x.transactionManager)) {
    result.push("convert-persistence-xml");
  }

  return result;
}

function serializeMigrationPatterns(patterns: MigrationPattern[]): string {
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

function serializeDetectedPatterns(patterns: DetectedPatterns): string {
  const lines: string[] = [];
  lines.push(`usesXmlConfiguration: ${patterns.usesXmlConfiguration}`);
  lines.push(`usesFieldInjection: ${patterns.usesFieldInjection} ${patterns.usesFieldInjection ? "(⚠ convert to constructor injection)" : ""}`);
  lines.push(`hasLegacyDispatcher: ${patterns.hasLegacyDispatcher} ${patterns.hasLegacyDispatcher ? "(⚠ remove DispatcherServlet config)" : ""}`);
  lines.push(`missingBootMain: ${patterns.missingBootMain} ${patterns.missingBootMain ? "(⚠ need @SpringBootApplication class)" : ""}`);
  lines.push(`hasMultipleXmlConfigs: ${patterns.hasMultipleXmlConfigs}`);
  lines.push(`usesPropertyPlaceholders: ${patterns.usesPropertyPlaceholders} ${patterns.usesPropertyPlaceholders ? "(→ move to application.properties)" : ""}`);
  lines.push(`hasCircularDependencies: ${patterns.hasCircularDependencies} ${patterns.hasCircularDependencies ? "(⚠ must resolve before migration)" : ""}`);
  return lines.join("\n");
}

export function buildCodebaseIntelligence(files: FileMap, analysis: ProjectAnalysis): CodebaseIntelligence {
  logger.info("Building codebase intelligence layer...");

  const fileSummaries = extractFileSummaries(files);
  logger.info(`Extracted ${fileSummaries.length} file summaries`);

  const xmlConfigs = parseXmlConfigs(files);
  logger.info(`Parsed ${xmlConfigs.length} XML config files`);

  const dependencyGraph = buildDependencyGraph(fileSummaries, xmlConfigs);
  logger.info(`Built dependency graph: ${dependencyGraph.nodes.length} nodes, ${dependencyGraph.edges.length} edges, ${dependencyGraph.summary.circularDependencies} cycles`);

  const buildSummary = analyzeBuildFile(files);
  logger.info(`Analyzed build file: type=${buildSummary.type}`);

  const graphSummary = dependencyGraph.summary;
  const detectedPatterns = computeDetectedPatterns(fileSummaries, xmlConfigs, buildSummary, graphSummary);
  const migrationPatterns = detectMigrationPatterns(xmlConfigs, buildSummary, fileSummaries, detectedPatterns);

  logger.info(`Detected patterns: xmlConfig=${detectedPatterns.usesXmlConfiguration}, fieldInj=${detectedPatterns.usesFieldInjection}, legacyDisp=${detectedPatterns.hasLegacyDispatcher}, missingMain=${detectedPatterns.missingBootMain}`);
  logger.info(`Migration patterns: [${migrationPatterns.join(", ")}]`);

  const byRole = (role: string) => fileSummaries.filter((f) => f.role === role).map((f) => f.path);

  const controllers = byRole("controller");
  const services = byRole("service");
  const repositories = byRole("repository");
  const configFiles = byRole("config");
  const entryPoints = byRole("entry");
  const models = byRole("model");
  const testFiles = byRole("test");

  const stats: ProjectStats = {
    totalFiles: Object.keys(files).length,
    sourceFiles: fileSummaries.length,
    controllers: controllers.length,
    services: services.length,
    repositories: repositories.length,
    models: models.length,
    configFiles: configFiles.length,
    xmlConfigFiles: xmlConfigs.length,
    testFiles: testFiles.length,
  };

  const keyFiles: KeyFiles = {
    controllers,
    services,
    repositories,
    configs: configFiles,
    entryPoints,
    models,
  };

  const partialIntelligence = {
    framework: analysis.framework,
    buildTool: analysis.buildTool,
    stats,
    patterns: detectedPatterns,
    graphSummary,
    keyFiles,
    fileSummaries,
    dependencyGraph,
    xmlConfigs,
    buildSummary,
    migrationPatterns,
    buildConfig: {
      hasBootParent: buildSummary.hasSpringBootParent ?? false,
      hasBootPlugin: buildSummary.hasSpringBootPlugin ?? false,
    },
  } as Omit<CodebaseIntelligence, "ir" | "serialized">;

  const ir = buildIR(partialIntelligence as CodebaseIntelligence);
  logger.info(`IR built: ${ir.components.length} components, ${ir.requiredTransformations.length} transformations`);

  const intelligence: CodebaseIntelligence = {
    ...partialIntelligence,
    ir,
    serialized: {
      fileSummaries: fileSummaries.map(serializeFileSummary).join("\n\n"),
      dependencyGraph: serializeDependencyGraph(dependencyGraph),
      xmlConfigs: serializeAllXmlSummaries(xmlConfigs),
      buildSummary: serializeBuildSummary(buildSummary),
      patterns: serializeMigrationPatterns(migrationPatterns),
      detectedPatterns: serializeDetectedPatterns(detectedPatterns),
      ir: serializeIR(ir),
    },
  };

  return intelligence;
}

export { type DetectedPatterns };

export function buildMigrationContextPrompt(intelligence: CodebaseIntelligence, userRequest: string): string {
  const sections: string[] = [];

  sections.push(`FRAMEWORK: ${intelligence.framework}`);
  sections.push(`BUILD TOOL: ${intelligence.buildTool}`);

  sections.push(`\n## PROJECT STATS`);
  sections.push(`Total Files: ${intelligence.stats.totalFiles}`);
  sections.push(`Source Files Analyzed: ${intelligence.stats.sourceFiles}`);
  sections.push(`Controllers: ${intelligence.stats.controllers}`);
  sections.push(`Services: ${intelligence.stats.services}`);
  sections.push(`Repositories: ${intelligence.stats.repositories}`);
  sections.push(`Models: ${intelligence.stats.models}`);
  sections.push(`Config Files: ${intelligence.stats.configFiles}`);
  sections.push(`XML Config Files: ${intelligence.stats.xmlConfigFiles}`);
  sections.push(`Test Files: ${intelligence.stats.testFiles}`);

  sections.push(`\n## GRAPH SUMMARY`);
  sections.push(`Nodes: ${intelligence.graphSummary.totalNodes}`);
  sections.push(`Edges: ${intelligence.graphSummary.totalEdges}`);
  sections.push(`Circular Dependencies: ${intelligence.graphSummary.circularDependencies}`);
  if (intelligence.graphSummary.circularPaths.length > 0) {
    sections.push(`Circular Paths: ${intelligence.graphSummary.circularPaths.map((p) => p.map((f) => f.split("/").pop()).join(" → ")).join("; ")}`);
  }
  if (intelligence.graphSummary.unusedBeans.length > 0) {
    sections.push(`Potentially Unused Beans: ${intelligence.graphSummary.unusedBeans.slice(0, 5).map((f) => f.split("/").pop()).join(", ")}`);
  }

  sections.push(`\n## DETECTED PATTERNS`);
  sections.push(intelligence.serialized.detectedPatterns);

  sections.push(`\n## KEY FILES`);
  sections.push(`Entry Points: ${intelligence.keyFiles.entryPoints.join(", ") || "(none detected)"}`);
  sections.push(`Controllers: ${intelligence.keyFiles.controllers.slice(0, 15).join(", ")}`);
  sections.push(`Services: ${intelligence.keyFiles.services.slice(0, 15).join(", ")}`);
  sections.push(`Repositories: ${intelligence.keyFiles.repositories.slice(0, 15).join(", ")}`);
  sections.push(`Configs: ${intelligence.keyFiles.configs.slice(0, 10).join(", ")}`);
  sections.push(`Models: ${intelligence.keyFiles.models.slice(0, 15).join(", ")}`);

  sections.push(`\n## BUILD FILE ANALYSIS`);
  sections.push(intelligence.serialized.buildSummary);

  sections.push(`\n## XML CONFIGURATION ANALYSIS`);
  sections.push(intelligence.serialized.xmlConfigs);

  sections.push(`\n## DEPENDENCY GRAPH`);
  sections.push(intelligence.serialized.dependencyGraph);

  sections.push(`\n## SEMANTIC FILE SUMMARIES`);
  const MAX_PROMPT_FILES = 40;

  const prioritizedSummaries = [
    ...intelligence.fileSummaries.filter((f) => f.role === "entry"),
    ...intelligence.fileSummaries.filter((f) => f.role === "config"),
    ...intelligence.fileSummaries.filter((f) => f.role === "controller"),
    ...intelligence.fileSummaries.filter((f) => f.role === "service"),
    ...intelligence.fileSummaries.filter((f) => f.role === "repository"),
    ...intelligence.fileSummaries.filter((f) => f.role === "model"),
    ...intelligence.fileSummaries.filter((f) => f.role === "other"),
  ].slice(0, MAX_PROMPT_FILES);

  sections.push(prioritizedSummaries.map(serializeFileSummary).join("\n\n"));

  sections.push(`\n## INTERMEDIATE REPRESENTATION (IR)`);
  sections.push(intelligence.serialized.ir);

  sections.push(`\n## REQUIRED MIGRATION ACTIONS`);
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

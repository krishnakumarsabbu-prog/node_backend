import type { CodebaseIntelligence } from "../intelligence/contextBuilder";
import type { FileSummary } from "../intelligence/semanticExtractor";
import type { XmlFileSummary } from "../intelligence/xmlConfigParser";
import type { BuildFileSummary } from "../intelligence/dependencyAnalyzer";
import type {
  IrProjectModel,
  IrComponent,
  IrBeanDefinition,
  IrRoute,
  IrBuildConfig,
  IrXmlConfig,
  IrField,
  IrMethod,
  IrEndpoint,
  IrTransformation,
  IrTransformationType,
  InjectionStyle,
  ComponentRole,
  HttpVerb,
} from "./irTypes";
import { createScopedLogger } from "../../utils/logger";

const logger = createScopedLogger("ir-builder");

export function buildIR(intelligence: CodebaseIntelligence): IrProjectModel {
  logger.info(`Building IR from ${intelligence.fileSummaries.length} file summaries`);

  const components = intelligence.fileSummaries.map((fs) => buildComponent(fs, intelligence));
  const beans = buildBeans(intelligence);
  const routes = buildRoutes(intelligence);
  const buildConfig = buildBuildConfig(intelligence.buildSummary, intelligence.buildTool);
  const xmlConfigs = buildXmlConfigs(intelligence.xmlConfigs);
  const requiredTransformations = buildTransformations(intelligence, components);

  const stats = computeStats(components, intelligence);

  const model: IrProjectModel = {
    framework: intelligence.framework,
    buildTool: intelligence.buildTool,
    components,
    beans,
    routes,
    buildConfig,
    properties: [],
    xmlConfigs,
    requiredTransformations,
    stats,
  };

  logger.info(
    `IR built: ${components.length} components, ${beans.length} beans, ` +
    `${routes.length} routes, ${requiredTransformations.length} transformations`,
  );

  return model;
}

function buildComponent(fs: FileSummary, intelligence: CodebaseIntelligence): IrComponent {
  const role = fs.role as ComponentRole;
  const className = fs.classNames[0] ?? fs.path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "Unknown";

  const packagePath = extractPackagePath(fs.path);

  const fields: IrField[] = (fs.injectedFields ?? []).map((f) => ({
    name: f.name,
    type: f.type,
    injected: true,
    injectionStyle: f.injectionStyle,
  }));

  const methods: IrMethod[] = (fs.methods ?? []).map((m) => ({
    name: m.name,
    returnType: m.returnType ?? "void",
    paramTypes: [],
    isPublic: true,
  }));

  const endpoints: IrEndpoint[] = extractEndpoints(fs);

  const injectionStyle: InjectionStyle =
    fs.usesConstructorInjection ? "constructor" :
    fs.usesFieldInjection ? "field" :
    "none";

  const outgoingEdges = intelligence.dependencyGraph.edges.filter(
    (e) => e.from === fs.path,
  );
  const dependsOn = outgoingEdges.map((e) => e.to);

  return {
    id: fs.path,
    role,
    sourceFile: fs.path,
    className,
    packagePath,
    annotations: fs.annotations,
    imports: fs.imports,
    fields,
    methods,
    endpoints,
    injectionStyle,
    dependsOn,
    isEntryPoint: fs.isSpringBootMain || role === "entry",
    isXmlDefined: false,
  };
}

function extractEndpoints(fs: FileSummary): IrEndpoint[] {
  const endpoints: IrEndpoint[] = [];

  if (fs.role !== "controller") return endpoints;

  for (const method of fs.methods ?? []) {
    const verbMap: Record<string, HttpVerb> = {
      GetMapping: "GET",
      PostMapping: "POST",
      PutMapping: "PUT",
      DeleteMapping: "DELETE",
      PatchMapping: "PATCH",
      RequestMapping: "ANY",
    };

    for (const [annotationKey, verb] of Object.entries(verbMap)) {
      if (fs.annotations.some((a) => a.includes(annotationKey))) {
        endpoints.push({
          method: verb,
          path: "/unknown",
          handlerName: method.name,
        });
        break;
      }
    }
  }

  return endpoints;
}

function extractPackagePath(filePath: string): string {
  const parts = filePath.split("/");
  const javaIndex = parts.indexOf("java");
  if (javaIndex !== -1) {
    return parts.slice(javaIndex + 1, -1).join(".");
  }
  return "";
}

function buildBeans(intelligence: CodebaseIntelligence): IrBeanDefinition[] {
  const beans: IrBeanDefinition[] = [];

  for (const xmlConfig of intelligence.xmlConfigs) {
    for (const bean of xmlConfig.beans ?? []) {
      const properties: Record<string, string> = {};
      for (const p of bean.propertyRefs ?? []) {
        properties[p.name] = `ref:${p.ref}`;
      }
      for (const c of bean.constructorArgs ?? []) {
        if (c.ref) {
          const key = c.index !== undefined ? `constructor-arg[${c.index}]` : `constructor-arg`;
          properties[key] = `ref:${c.ref}`;
        } else if (c.value !== undefined) {
          const key = c.index !== undefined ? `constructor-arg[${c.index}]` : `constructor-arg`;
          properties[key] = `value:${c.value}`;
        }
      }
      beans.push({
        beanName: bean.id,
        beanClass: bean.className,
        scope: (bean.scope as any) ?? "singleton",
        sourceFile: xmlConfig.file,
        isXmlDefined: true,
        properties,
      });
    }
  }

  for (const fs of intelligence.fileSummaries) {
    if (!["service", "repository", "controller", "config"].includes(fs.role)) continue;
    const className = fs.classNames[0];
    if (!className) continue;
    const beanName = className.charAt(0).toLowerCase() + className.slice(1);
    if (beans.some((b) => b.beanName === beanName)) continue;
    beans.push({
      beanName,
      beanClass: className,
      scope: "singleton",
      sourceFile: fs.path,
      isXmlDefined: false,
      properties: {},
    });
  }

  return beans;
}

function buildRoutes(intelligence: CodebaseIntelligence): IrRoute[] {
  const routes: IrRoute[] = [];

  for (const xmlConfig of intelligence.xmlConfigs) {
    for (const mapping of xmlConfig.servletMappings ?? []) {
      routes.push({
        method: "ANY",
        path: mapping,
        handlerClass: "DispatcherServlet",
        handlerMethod: "service",
        sourceFile: xmlConfig.file,
      });
    }
  }

  for (const fs of intelligence.fileSummaries) {
    if (fs.role !== "controller") continue;
    const className = fs.classNames[0] ?? fs.path;
    for (const method of fs.methods ?? []) {
      routes.push({
        method: "ANY",
        path: "/unknown",
        handlerClass: className,
        handlerMethod: method.name,
        sourceFile: fs.path,
      });
    }
  }

  return routes;
}

function buildBuildConfig(buildSummary: BuildFileSummary, buildTool: string): IrBuildConfig {
  return {
    buildTool,
    groupId: buildSummary.groupId ?? "",
    artifactId: buildSummary.artifactId ?? "",
    version: buildSummary.projectVersion ?? "",
    hasBootParent: buildSummary.hasSpringBootParent ?? false,
    hasBootPlugin: buildSummary.hasSpringBootPlugin ?? false,
    dependencies: (buildSummary.jvmDependencies ?? []).map((d) => ({
      groupId: d.groupId ?? "",
      artifactId: d.artifactId ?? "",
      version: d.version ?? "",
      scope: (d.scope as any) ?? "compile",
      category: d.category ?? "other",
    })),
    pluginIds: buildSummary.plugins ?? [],
  };
}

function buildXmlConfigs(xmlConfigs: XmlFileSummary[]): IrXmlConfig[] {
  return xmlConfigs.map((x) => ({
    sourceFile: x.file,
    xmlType: x.xmlType,
    beanCount: x.beanCount,
    servletMappings: x.servletMappings ?? [],
    componentScanPackages: [],
    featureFlags: {
      hasDataSource: x.dataSource ?? false,
      hasTransactionManager: x.transactionManager ?? false,
      hasSecurity: x.securityConfig ?? false,
      hasViewResolver: x.viewResolver ?? false,
    },
  }));
}

function buildTransformations(
  intelligence: CodebaseIntelligence,
  components: IrComponent[],
): IrTransformation[] {
  const transformations: IrTransformation[] = [];
  const { patterns, migrationPatterns } = intelligence;

  const priority: Record<IrTransformationType, number> = {
    "update-build-parent": 100,
    "add-boot-plugin": 95,
    "add-starter-web": 90,
    "add-starter-data-jpa": 85,
    "add-spring-boot-main": 80,
    "remove-web-xml": 75,
    "xml-to-annotation-config": 70,
    "convert-xml-beans": 65,
    "convert-security-config": 60,
    "convert-persistence-config": 55,
    "field-to-constructor-injection": 50,
    "add-application-properties": 40,
  };

  if (!intelligence.buildConfig?.hasBootParent) {
    transformations.push({
      type: "update-build-parent",
      affectedFiles: [intelligence.buildTool === "maven" ? "pom.xml" : "build.gradle"],
      description: "Replace parent POM with spring-boot-starter-parent",
      priority: priority["update-build-parent"],
    });
  }

  if (!intelligence.buildConfig?.hasBootPlugin) {
    transformations.push({
      type: "add-boot-plugin",
      affectedFiles: [intelligence.buildTool === "maven" ? "pom.xml" : "build.gradle"],
      description: "Add spring-boot-maven-plugin to build plugins",
      priority: priority["add-boot-plugin"],
    });
  }

  if (migrationPatterns.includes("add-spring-boot-main")) {
    transformations.push({
      type: "add-spring-boot-main",
      affectedFiles: [],
      description: "Create @SpringBootApplication main entry class",
      priority: priority["add-spring-boot-main"],
    });
  }

  if (migrationPatterns.includes("remove-web-xml")) {
    const webXmlFiles = intelligence.xmlConfigs
      .filter((x) => x.xmlType === "web-xml")
      .map((x) => x.file);
    transformations.push({
      type: "remove-web-xml",
      affectedFiles: webXmlFiles,
      description: "Remove web.xml — Spring Boot uses embedded Tomcat with auto-configuration",
      priority: priority["remove-web-xml"],
    });
  }

  if (migrationPatterns.includes("xml-to-annotation")) {
    const xmlFiles = intelligence.xmlConfigs.map((x) => x.file);
    transformations.push({
      type: "xml-to-annotation-config",
      affectedFiles: xmlFiles,
      description: "Convert all XML-based Spring config to @Configuration Java classes",
      priority: priority["xml-to-annotation-config"],
    });
  }

  if (migrationPatterns.includes("convert-xml-beans")) {
    const affectedFiles = intelligence.xmlConfigs
      .filter((x) => x.beanCount > 0)
      .map((x) => x.file);
    transformations.push({
      type: "convert-xml-beans",
      affectedFiles,
      description: "Convert all <bean> XML definitions to @Bean methods in @Configuration classes",
      priority: priority["convert-xml-beans"],
    });
  }

  if (patterns.usesFieldInjection) {
    const fieldInjectionFiles = components
      .filter((c) => c.injectionStyle === "field")
      .map((c) => c.sourceFile);
    transformations.push({
      type: "field-to-constructor-injection",
      affectedFiles: fieldInjectionFiles,
      description: "Replace @Autowired field injection with constructor injection in all components",
      priority: priority["field-to-constructor-injection"],
    });
  }

  if (migrationPatterns.includes("convert-security-xml")) {
    const secFiles = intelligence.xmlConfigs
      .filter((x) => x.securityConfig)
      .map((x) => x.file);
    transformations.push({
      type: "convert-security-config",
      affectedFiles: secFiles,
      description: "Convert Spring Security XML to SecurityFilterChain @Bean",
      priority: priority["convert-security-config"],
    });
  }

  if (migrationPatterns.includes("convert-persistence-xml")) {
    const persFiles = intelligence.xmlConfigs
      .filter((x) => x.dataSource || x.transactionManager)
      .map((x) => x.file);
    transformations.push({
      type: "convert-persistence-config",
      affectedFiles: persFiles,
      description: "Convert DataSource/TransactionManager XML to application.properties + @EnableJpaRepositories",
      priority: priority["convert-persistence-config"],
    });
  }

  if (migrationPatterns.includes("add-application-properties")) {
    transformations.push({
      type: "add-application-properties",
      affectedFiles: [],
      description: "Create src/main/resources/application.properties with Spring Boot property keys",
      priority: priority["add-application-properties"],
    });
  }

  transformations.sort((a, b) => b.priority - a.priority);
  return transformations;
}

function computeStats(
  components: IrComponent[],
  intelligence: CodebaseIntelligence,
) {
  const fieldCount = components.filter((c) => c.injectionStyle === "field").length;
  const ctorCount = components.filter((c) => c.injectionStyle === "constructor").length;
  const xmlBeanCount = intelligence.xmlConfigs.reduce((n, x) => n + (x.beanCount ?? 0), 0);
  const hasBootMain = intelligence.fileSummaries.some((f) => f.isSpringBootMain);
  const hasWebXml = intelligence.xmlConfigs.some((x) => x.xmlType === "web-xml");

  return {
    totalComponents: components.length,
    controllers: components.filter((c) => c.role === "controller").length,
    services: components.filter((c) => c.role === "service").length,
    repositories: components.filter((c) => c.role === "repository").length,
    xmlDefinedBeans: xmlBeanCount,
    fieldInjectionCount: fieldCount,
    constructorInjectionCount: ctorCount,
    hasBootMain,
    hasWebXml,
  };
}

export function serializeIR(model: IrProjectModel): string {
  const lines: string[] = [];

  lines.push(`## IR PROJECT MODEL`);
  lines.push(`Framework: ${model.framework} → Spring Boot`);
  lines.push(`Build Tool: ${model.buildTool}`);
  lines.push(``);
  lines.push(`## STATS`);
  lines.push(`Total Components: ${model.stats.totalComponents}`);
  lines.push(`Controllers: ${model.stats.controllers}`);
  lines.push(`Services: ${model.stats.services}`);
  lines.push(`Repositories: ${model.stats.repositories}`);
  lines.push(`XML-Defined Beans: ${model.stats.xmlDefinedBeans}`);
  lines.push(`Field Injection: ${model.stats.fieldInjectionCount} component(s) — must convert to constructor injection`);
  lines.push(`Constructor Injection: ${model.stats.constructorInjectionCount} component(s)`);
  lines.push(`Has @SpringBootApplication: ${model.stats.hasBootMain}`);
  lines.push(`Has web.xml: ${model.stats.hasWebXml}`);
  lines.push(``);
  lines.push(`## REQUIRED TRANSFORMATIONS (ordered by priority)`);
  for (const t of model.requiredTransformations) {
    lines.push(`  [${t.priority}] ${t.type}: ${t.description}`);
    if (t.affectedFiles.length > 0) {
      lines.push(`    → files: ${t.affectedFiles.map((f) => f.split("/").pop()).join(", ")}`);
    }
  }
  lines.push(``);
  lines.push(`## BUILD CONFIG`);
  lines.push(`  groupId: ${model.buildConfig.groupId}`);
  lines.push(`  artifactId: ${model.buildConfig.artifactId}`);
  lines.push(`  hasBootParent: ${model.buildConfig.hasBootParent}`);
  lines.push(`  hasBootPlugin: ${model.buildConfig.hasBootPlugin}`);
  lines.push(`  dependencies (${model.buildConfig.dependencies.length}): ${model.buildConfig.dependencies.map((d) => d.artifactId).slice(0, 10).join(", ")}`);
  lines.push(``);
  lines.push(`## COMPONENTS (${model.components.length})`);
  for (const c of model.components.slice(0, 30)) {
    lines.push(
      `  [${c.role.toUpperCase()}] ${c.className} @ ${c.sourceFile.split("/").pop()} ` +
      `injection=${c.injectionStyle} deps=${c.dependsOn.length} endpoints=${c.endpoints.length} xmlDefined=${c.isXmlDefined}`,
    );
  }
  lines.push(``);
  lines.push(`## XML CONFIGS (${model.xmlConfigs.length})`);
  for (const x of model.xmlConfigs) {
    lines.push(
      `  [${x.xmlType}] ${x.sourceFile.split("/").pop()} ` +
      `beans=${x.beanCount} ` +
      `dataSource=${x.featureFlags.hasDataSource} security=${x.featureFlags.hasSecurity} txMgr=${x.featureFlags.hasTransactionManager}`,
    );
  }

  const xmlBeans = model.beans.filter((b) => b.isXmlDefined);
  if (xmlBeans.length > 0) {
    lines.push(``);
    lines.push(`## XML BEAN WIRING (${xmlBeans.length} beans — must convert to @Bean methods)`);
    for (const b of xmlBeans) {
      const shortClass = b.beanClass.split(".").pop() ?? b.beanClass;
      const wiringEntries = Object.entries(b.properties ?? {});
      const wiringStr = wiringEntries.length > 0
        ? ` → { ${wiringEntries.map(([k, v]) => `${k}: ${v}`).join(", ")} }`
        : "";
      const scopeStr = b.scope !== "singleton" ? ` @Scope("${b.scope}")` : "";
      lines.push(`  @Bean${scopeStr} ${b.beanName}(): ${shortClass} [from ${b.sourceFile.split("/").pop()}]${wiringStr}`);
    }
  }

  return lines.join("\n");
}

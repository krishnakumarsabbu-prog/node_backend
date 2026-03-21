import type { FileMap } from "../../llm/constants";

export type DependencyCategory =
  | "spring-core"
  | "spring-mvc"
  | "spring-boot"
  | "spring-security"
  | "spring-data"
  | "hibernate"
  | "jpa"
  | "database"
  | "testing"
  | "logging"
  | "web"
  | "build-plugin"
  | "other";

export interface DependencySummary {
  groupId: string;
  artifactId: string;
  version: string;
  category: DependencyCategory;
  scope?: string;
}

export interface NpmDependency {
  name: string;
  version: string;
  category: DependencyCategory;
  isDev: boolean;
}

export interface BuildFileSummary {
  type: "maven" | "gradle" | "npm" | "yarn" | "pnpm" | "pip" | "cargo" | "go" | "other";
  jvmDependencies?: DependencySummary[];
  npmDependencies?: NpmDependency[];
  pythonDependencies?: string[];
  springBootVersion?: string;
  javaVersion?: string;
  nodeVersion?: string;
  groupId?: string;
  artifactId?: string;
  projectVersion?: string;
  plugins?: string[];
  hasSpringBootParent: boolean;
  hasSpringBootPlugin: boolean;
  migrationRequirements?: string[];
}

function categorizeMavenDep(groupId: string, artifactId: string): DependencyCategory {
  const g = groupId.toLowerCase();
  const a = artifactId.toLowerCase();

  if (a.includes("spring-boot-starter-test") || a.includes("junit") || a.includes("mockito")) return "testing";
  if (a === "spring-boot-starter-parent" || a.includes("spring-boot-starter")) return "spring-boot";
  if (g === "org.springframework.boot") return "spring-boot";
  if (a.includes("spring-webmvc") || a.includes("spring-web")) return "spring-mvc";
  if (a.includes("spring-security")) return "spring-security";
  if (a.includes("spring-data")) return "spring-data";
  if (g.includes("springframework") && (a.includes("spring-core") || a.includes("spring-context") || a.includes("spring-beans"))) return "spring-core";
  if (g.includes("springframework")) return "spring-core";
  if (g === "org.hibernate" || a.includes("hibernate")) return "hibernate";
  if (g === "javax.persistence" || g === "jakarta.persistence") return "jpa";
  if (g.includes("mysql") || g.includes("postgresql") || g.includes("h2") || a.includes("jdbc") || a.includes("datasource")) return "database";
  if (a.includes("logback") || a.includes("log4j") || a.includes("slf4j")) return "logging";
  if (a.includes("servlet") || a.includes("tomcat") || a.includes("jetty")) return "web";
  return "other";
}

function resolveMavenProperties(content: string): Map<string, string> {
  const props = new Map<string, string>();
  const propRe = /<properties>([\s\S]*?)<\/properties>/g;
  let pm: RegExpExecArray | null;
  while ((pm = propRe.exec(content)) !== null) {
    const block = pm[1];
    const entryRe = /<([a-zA-Z0-9.\-_]+)>([^<]+)<\/\1>/g;
    let em: RegExpExecArray | null;
    while ((em = entryRe.exec(block)) !== null) {
      props.set(em[1], em[2].trim());
    }
  }
  return props;
}

function resolveVersion(raw: string | undefined, props: Map<string, string>): string {
  if (!raw) return "managed";
  const trimmed = raw.trim();
  const match = trimmed.match(/^\$\{([^}]+)\}$/);
  if (match) return props.get(match[1]) ?? trimmed;
  return trimmed;
}

function parseMavenPom(content: string): Partial<BuildFileSummary> {
  const deps: DependencySummary[] = [];
  const plugins: string[] = [];

  const mavenProps = resolveMavenProperties(content);

  const projectGroupIdMatch = content.match(/<project[^>]*>[\s\S]*?<groupId>([^<]+)<\/groupId>/);
  const projectArtifactIdMatch = content.match(/<project[^>]*>[\s\S]*?<artifactId>([^<]+)<\/artifactId>/);
  const projectVersionMatch = content.match(/<project[^>]*>[\s\S]*?<version>([^<]+)<\/version>/);

  const javaVersionRaw = mavenProps.get("java.version") ??
    mavenProps.get("maven.compiler.source") ??
    content.match(/<java\.version>([^<]+)<\/java\.version>/)?.[1] ??
    content.match(/<maven\.compiler\.source>([^<]+)<\/maven\.compiler\.source>/)?.[1];

  const parentBlockMatch = content.match(/<parent>([\s\S]*?)<\/parent>/);
  const parentBlock = parentBlockMatch ? parentBlockMatch[1] : "";
  const parentArtifactId = parentBlock.match(/<artifactId>([^<]+)<\/artifactId>/)?.[1]?.trim() ?? "";
  const parentVersionRaw = parentBlock.match(/<version>([^<]+)<\/version>/)?.[1]?.trim();
  const parentVersion = resolveVersion(parentVersionRaw, mavenProps);
  const hasSpringBootParent = parentArtifactId.includes("spring-boot-starter-parent") ||
    parentArtifactId.includes("spring-boot-dependencies");

  let springBootVersion: string | undefined;
  if (hasSpringBootParent && parentVersion !== "managed") {
    springBootVersion = parentVersion;
  } else {
    const sbVersionMatch = content.match(/spring-boot[^<]*[\s\S]{0,100}<version>([^<]+)<\/version>/);
    if (sbVersionMatch) springBootVersion = resolveVersion(sbVersionMatch[1], mavenProps);
  }

  const depRe = /<dependency>\s*<groupId>([^<]+)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>(?:\s*<version>([^<]*)<\/version>)?(?:[\s\S]*?<scope>([^<]*)<\/scope>)?/g;
  let m: RegExpExecArray | null;

  while ((m = depRe.exec(content)) !== null) {
    const groupId = m[1].trim();
    const artifactId = m[2].trim();
    const version = resolveVersion(m[3], mavenProps);
    const scope = m[4]?.trim();
    deps.push({ groupId, artifactId, version, category: categorizeMavenDep(groupId, artifactId), scope });
  }

  const pluginRe = /<plugin>[\s\S]*?<artifactId>([^<]+)<\/artifactId>/g;
  while ((m = pluginRe.exec(content)) !== null) {
    plugins.push(m[1].trim());
  }

  const migrationRequirements: string[] = [];
  const hasWebMvcDep = deps.some((d) => d.artifactId.includes("spring-webmvc"));
  const hasBootDep = deps.some((d) => d.category === "spring-boot") || hasSpringBootParent;
  const hasServletApiDep = deps.some((d) =>
    (d.artifactId.includes("servlet-api") || d.artifactId.includes("javax.servlet")) &&
    d.scope !== "provided"
  );
  const hasServletApiProvided = deps.some((d) =>
    (d.artifactId.includes("servlet-api") || d.artifactId.includes("javax.servlet")) &&
    d.scope === "provided"
  );

  if (!hasBootDep) {
    migrationRequirements.push("Add spring-boot-starter-parent as parent POM");
    if (hasWebMvcDep) {
      migrationRequirements.push("Replace spring-webmvc with spring-boot-starter-web");
    }
    migrationRequirements.push("Add spring-boot-maven-plugin");
  }

  if (hasServletApiDep || hasServletApiProvided) {
    migrationRequirements.push("Remove servlet-api dependency (embedded Tomcat provides it via spring-boot-starter-web)");
  }

  if (deps.some((d) => d.category === "hibernate" || d.category === "jpa")) {
    migrationRequirements.push("Add spring-boot-starter-data-jpa (replaces hibernate-core + javax.persistence)");
  }

  if (deps.some((d) => d.category === "spring-security")) {
    migrationRequirements.push("Add spring-boot-starter-security");
  }

  if (deps.some((d) => d.groupId === "javax.validation" || d.groupId === "jakarta.validation")) {
    migrationRequirements.push("Add spring-boot-starter-validation (includes jakarta.validation)");
  }

  if (deps.some((d) => d.groupId.startsWith("javax.") && !d.groupId.startsWith("javax.persistence"))) {
    migrationRequirements.push("Check javax.* → jakarta.* namespace migration (Spring Boot 3.x requires jakarta)");
  }

  const javaVer = javaVersionRaw ? parseInt(javaVersionRaw.replace(/[^0-9]/g, ""), 10) : 0;
  if (javaVer > 0 && javaVer < 17) {
    migrationRequirements.push(`Upgrade Java from ${javaVersionRaw} to Java 17+ (required for Spring Boot 3.x)`);
  }

  return {
    jvmDependencies: deps,
    plugins,
    groupId: projectGroupIdMatch ? projectGroupIdMatch[1].trim() : undefined,
    artifactId: projectArtifactIdMatch ? projectArtifactIdMatch[1].trim() : undefined,
    projectVersion: projectVersionMatch ? resolveVersion(projectVersionMatch[1], mavenProps) : undefined,
    javaVersion: javaVersionRaw ?? undefined,
    springBootVersion,
    hasSpringBootParent,
    hasSpringBootPlugin: content.includes("spring-boot-maven-plugin"),
    migrationRequirements,
  };
}

function categorizeNpmDep(name: string): DependencyCategory {
  if (name.startsWith("@types/") || name.includes("eslint") || name.includes("jest") || name.includes("mocha") || name.includes("vitest") || name.includes("testing")) return "testing";
  if (name.includes("react") || name.includes("vue") || name.includes("angular") || name.includes("svelte") || name.includes("next") || name.includes("nuxt")) return "web";
  if (name.includes("express") || name.includes("fastify") || name.includes("koa") || name.includes("nest") || name.includes("hono")) return "web";
  if (name.includes("winston") || name.includes("pino") || name.includes("morgan")) return "logging";
  if (name.includes("typeorm") || name.includes("prisma") || name.includes("sequelize") || name.includes("mongoose")) return "database";
  return "other";
}

function parsePackageJson(content: string): Partial<BuildFileSummary> {
  let pkg: any;
  try { pkg = JSON.parse(content); } catch { return { hasSpringBootParent: false, hasSpringBootPlugin: false }; }

  const deps: NpmDependency[] = [];

  for (const [name, version] of Object.entries(pkg.dependencies || {})) {
    deps.push({ name, version: String(version), category: categorizeNpmDep(name), isDev: false });
  }
  for (const [name, version] of Object.entries(pkg.devDependencies || {})) {
    deps.push({ name, version: String(version), category: categorizeNpmDep(name), isDev: true });
  }

  return {
    npmDependencies: deps,
    projectVersion: pkg.version,
    nodeVersion: pkg.engines?.node,
    groupId: pkg.name,
    hasSpringBootParent: false,
    hasSpringBootPlugin: false,
  };
}

function parsePipRequirements(content: string): Partial<BuildFileSummary> {
  const deps = content.split("\n")
    .map((line) => line.trim().split(/[>=<!=]/)[0].trim())
    .filter((d) => d && !d.startsWith("#"));

  return {
    pythonDependencies: deps,
    hasSpringBootParent: false,
    hasSpringBootPlugin: false,
  };
}

export function analyzeBuildFile(files: FileMap): BuildFileSummary {
  const filePaths = Object.keys(files);

  const pomPath = filePaths.find((p) => p.endsWith("pom.xml"));
  if (pomPath) {
    const content = (files[pomPath] as any)?.content as string || "";
    return { type: "maven", ...parseMavenPom(content) } as BuildFileSummary;
  }

  const pkgPath = filePaths.find((p) => p.endsWith("package.json") && !p.includes("node_modules"));
  if (pkgPath) {
    const content = (files[pkgPath] as any)?.content as string || "";
    const buildTool = filePaths.some((p) => p.endsWith("pnpm-lock.yaml")) ? "pnpm"
      : filePaths.some((p) => p.endsWith("yarn.lock")) ? "yarn"
      : "npm";
    return { type: buildTool, ...parsePackageJson(content) } as BuildFileSummary;
  }

  const reqPath = filePaths.find((p) => p.endsWith("requirements.txt"));
  if (reqPath) {
    const content = (files[reqPath] as any)?.content as string || "";
    return { type: "pip", ...parsePipRequirements(content) } as BuildFileSummary;
  }

  return { type: "other", hasSpringBootParent: false, hasSpringBootPlugin: false };
}

export function serializeBuildSummary(build: BuildFileSummary): string {
  const lines: string[] = [`Build Tool: ${build.type.toUpperCase()}`];

  if (build.groupId) lines.push(`Project: ${build.groupId}:${build.artifactId || "?"} v${build.projectVersion || "?"}`);
  if (build.javaVersion) lines.push(`Java Version: ${build.javaVersion}`);
  if (build.springBootVersion) lines.push(`Spring Boot Version: ${build.springBootVersion}`);

  if (build.jvmDependencies && build.jvmDependencies.length > 0) {
    const byCategory: Partial<Record<DependencyCategory, string[]>> = {};
    for (const dep of build.jvmDependencies) {
      if (!byCategory[dep.category]) byCategory[dep.category] = [];
      byCategory[dep.category]!.push(`${dep.artifactId}:${dep.version}`);
    }
    lines.push("Dependencies:");
    for (const [cat, deps] of Object.entries(byCategory)) {
      lines.push(`  [${cat}]: ${deps!.slice(0, 5).join(", ")}${deps!.length > 5 ? ` (+${deps!.length - 5} more)` : ""}`);
    }
  }

  if (build.npmDependencies && build.npmDependencies.length > 0) {
    const prod = build.npmDependencies.filter((d) => !d.isDev);
    const dev = build.npmDependencies.filter((d) => d.isDev);
    lines.push(`Dependencies: ${prod.map((d) => d.name).slice(0, 10).join(", ")}`);
    lines.push(`DevDependencies: ${dev.map((d) => d.name).slice(0, 8).join(", ")}`);
  }

  if (build.migrationRequirements && build.migrationRequirements.length > 0) {
    lines.push("Required for migration:");
    for (const req of build.migrationRequirements) {
      lines.push(`  → ${req}`);
    }
  }

  if (build.plugins && build.plugins.length > 0) {
    lines.push(`Plugins: ${build.plugins.join(", ")}`);
  }

  return lines.join("\n");
}

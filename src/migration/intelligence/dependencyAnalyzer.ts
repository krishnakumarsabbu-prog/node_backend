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

function parseMavenPom(content: string): Partial<BuildFileSummary> {
  const deps: DependencySummary[] = [];
  const plugins: string[] = [];

  const groupIdMatch = content.match(/<groupId>([^<]+)<\/groupId>/);
  const artifactIdMatch = content.match(/<artifactId>([^<]+)<\/artifactId>/);
  const versionMatch = content.match(/<version>([^<]+)<\/version>/);
  const javaVersionMatch = content.match(/<java\.version>([^<]+)<\/java\.version>/) ||
    content.match(/<maven\.compiler\.source>([^<]+)<\/maven\.compiler\.source>/);

  const springBootVersionMatch = content.match(/spring-boot[^<]*<version>([^<]+)<\/version>/) ||
    content.match(/<parent>[\s\S]*?spring-boot[\s\S]*?<version>([^<]+)<\/version>/);

  const depRe = /<dependency>\s*<groupId>([^<]+)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>(?:\s*<version>([^<]*)<\/version>)?(?:\s*<scope>([^<]*)<\/scope>)?/g;
  let m: RegExpExecArray | null;

  while ((m = depRe.exec(content)) !== null) {
    const groupId = m[1].trim();
    const artifactId = m[2].trim();
    const version = m[3]?.trim() || "managed";
    const scope = m[4]?.trim();
    deps.push({ groupId, artifactId, version, category: categorizeMavenDep(groupId, artifactId), scope });
  }

  const pluginRe = /<plugin>[\s\S]*?<artifactId>([^<]+)<\/artifactId>/g;
  while ((m = pluginRe.exec(content)) !== null) {
    plugins.push(m[1].trim());
  }

  const migrationRequirements: string[] = [];
  const hasWebXmlDep = deps.some((d) => d.artifactId.includes("spring-webmvc"));
  const hasBootDep = deps.some((d) => d.category === "spring-boot");

  if (hasWebXmlDep && !hasBootDep) {
    migrationRequirements.push("Add spring-boot-starter-parent");
    migrationRequirements.push("Replace spring-webmvc with spring-boot-starter-web");
    migrationRequirements.push("Add spring-boot-maven-plugin");
  }

  if (deps.some((d) => d.category === "hibernate" || d.category === "jpa")) {
    migrationRequirements.push("Add spring-boot-starter-data-jpa");
  }

  if (deps.some((d) => d.category === "spring-security")) {
    migrationRequirements.push("Add spring-boot-starter-security");
  }

  return {
    jvmDependencies: deps,
    plugins,
    groupId: groupIdMatch ? groupIdMatch[1].trim() : undefined,
    artifactId: artifactIdMatch ? artifactIdMatch[1].trim() : undefined,
    projectVersion: versionMatch ? versionMatch[1].trim() : undefined,
    javaVersion: javaVersionMatch ? javaVersionMatch[1].trim() : undefined,
    springBootVersion: springBootVersionMatch ? springBootVersionMatch[1].trim() : undefined,
    hasSpringBootParent: content.includes("spring-boot-starter-parent"),
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

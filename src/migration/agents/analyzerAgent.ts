import type { ProjectAnalysis, Framework, BuildTool, SpringArtifacts } from "../types/migrationTypes";
import type { FileMap } from "../../llm/constants";
import { createScopedLogger } from "../../utils/logger";

export type { SpringArtifacts };

const logger = createScopedLogger("analyzer-agent");

export class AnalyzerAgent {
  async analyze(files: FileMap): Promise<ProjectAnalysis> {
    logger.info("Starting project analysis");

    const analysis: ProjectAnalysis = {
      framework: "unknown",
      buildTool: "unknown",
      xmlConfigs: [],
      controllers: [],
      services: [],
      repositories: [],
      configFiles: [],
      dependencies: [],
      entryPoints: [],
      testFiles: [],
    };

    const filePaths = Object.keys(files);

    this.detectBuildTool(filePaths, files, analysis);
    this.detectFramework(filePaths, files, analysis);
    this.categorizeFiles(filePaths, analysis);
    this.detectEntryPoints(filePaths, files, analysis);
    this.detectDependencies(filePaths, files, analysis);

    const isSpring = analysis.framework === "spring-mvc" || analysis.framework === "spring-boot";
    if (isSpring) {
      const artifacts = this.detectSpringArtifacts(filePaths, files);
      logger.info(
        `Spring artifacts: filters=${artifacts.filters.length}, interceptors=${artifacts.interceptors.length}, ` +
        `listeners=${artifacts.listeners.length}, aspects=${artifacts.aspects.length}, ` +
        `exceptionHandlers=${artifacts.exceptionHandlers.length}, scheduledTasks=${artifacts.scheduledTasks.length}`
      );
      analysis.springArtifacts = artifacts;
    }

    logger.info(
      `Analysis complete: framework=${analysis.framework}, buildTool=${analysis.buildTool}, files=${filePaths.length}`
    );

    return analysis;
  }

  detectSpringArtifacts(filePaths: string[], files: FileMap): SpringArtifacts {
    const artifacts: SpringArtifacts = {
      filters: [],
      interceptors: [],
      listeners: [],
      aspects: [],
      validators: [],
      converters: [],
      exceptionHandlers: [],
      scheduledTasks: [],
    };

    for (const path of filePaths) {
      if (!path.endsWith(".java")) continue;
      const content = this.getFileContent(files, path);
      if (!content) continue;

      if (
        content.includes("implements Filter") ||
        content.includes("implements javax.servlet.Filter") ||
        content.includes("implements jakarta.servlet.Filter") ||
        content.includes("extends OncePerRequestFilter") ||
        content.includes("extends GenericFilterBean") ||
        content.includes("@WebFilter") ||
        (path.match(/Filter\.(java)$/) && content.includes("doFilter"))
      ) {
        artifacts.filters.push(path);
        continue;
      }

      if (
        content.includes("implements HandlerInterceptor") ||
        content.includes("extends HandlerInterceptorAdapter") ||
        content.includes("implements WebRequestInterceptor") ||
        path.match(/Interceptor\.(java)$/)
      ) {
        artifacts.interceptors.push(path);
        continue;
      }

      if (
        content.includes("implements ApplicationListener") ||
        content.includes("implements ServletContextListener") ||
        content.includes("implements HttpSessionListener") ||
        content.includes("@EventListener") ||
        path.match(/Listener\.(java)$/)
      ) {
        artifacts.listeners.push(path);
        continue;
      }

      if (
        content.includes("@Aspect") ||
        content.includes("@Before(") ||
        content.includes("@After(") ||
        content.includes("@Around(") ||
        content.includes("@AfterReturning(") ||
        content.includes("@AfterThrowing(")
      ) {
        artifacts.aspects.push(path);
        continue;
      }

      if (
        content.includes("implements Validator") ||
        content.includes("implements ConstraintValidator")
      ) {
        artifacts.validators.push(path);
        continue;
      }

      if (
        content.includes("implements Converter<") ||
        content.includes("implements GenericConverter") ||
        content.includes("implements HttpMessageConverter")
      ) {
        artifacts.converters.push(path);
        continue;
      }

      if (
        content.includes("@ControllerAdvice") ||
        content.includes("@RestControllerAdvice") ||
        content.includes("@ExceptionHandler")
      ) {
        artifacts.exceptionHandlers.push(path);
        continue;
      }

      if (
        content.includes("@Scheduled(") ||
        content.includes("@Async") ||
        content.includes("implements Job")
      ) {
        artifacts.scheduledTasks.push(path);
      }
    }

    return artifacts;
  }

  private getFileContent(files: FileMap, path: string): string {
    const file = files[path];
    return (file && "content" in file ? file.content : "") || "";
  }

  private detectBuildTool(filePaths: string[], files: FileMap, analysis: ProjectAnalysis): void {
    if (filePaths.some((p) => p.endsWith("pom.xml"))) {
      analysis.buildTool = "maven";
    } else if (filePaths.some((p) => p.includes("build.gradle"))) {
      analysis.buildTool = "gradle";
    } else if (filePaths.some((p) => p.endsWith("Cargo.toml"))) {
      analysis.buildTool = "cargo";
    } else if (filePaths.some((p) => p.endsWith("go.mod"))) {
      analysis.buildTool = "go-mod";
    } else if (filePaths.some((p) => p.endsWith("composer.json"))) {
      analysis.buildTool = "composer";
    } else if (filePaths.some((p) => p.match(/\.csproj$/) || p.match(/\.sln$/))) {
      analysis.buildTool = "dotnet";
    } else if (filePaths.some((p) => p.endsWith("mix.exs"))) {
      analysis.buildTool = "mix";
    } else if (filePaths.some((p) => p.endsWith("Gemfile"))) {
      analysis.buildTool = "bundler";
    } else if (filePaths.some((p) => p.endsWith("pyproject.toml"))) {
      const pyproject = filePaths.find((p) => p.endsWith("pyproject.toml"));
      if (pyproject) {
        const content = this.getFileContent(files, pyproject);
        analysis.buildTool = content.includes("[tool.poetry]") ? "poetry" : "pip";
      }
    } else if (filePaths.some((p) => p.endsWith("requirements.txt") || p.endsWith("setup.py"))) {
      analysis.buildTool = "pip";
    } else if (filePaths.some((p) => p.endsWith("pnpm-lock.yaml"))) {
      analysis.buildTool = "pnpm";
    } else if (filePaths.some((p) => p.endsWith("yarn.lock"))) {
      analysis.buildTool = "yarn";
    } else if (filePaths.some((p) => p.endsWith("package.json"))) {
      analysis.buildTool = "npm";
    }
  }

  private detectFramework(filePaths: string[], files: FileMap, analysis: ProjectAnalysis): void {
    if (this.detectJvmFramework(filePaths, files, analysis)) return;
    if (this.detectJsFramework(filePaths, files, analysis)) return;
    if (this.detectPythonFramework(filePaths, files, analysis)) return;
    if (this.detectRubyFramework(filePaths, files, analysis)) return;
    if (this.detectPhpFramework(filePaths, files, analysis)) return;
    if (this.detectGoFramework(filePaths, files, analysis)) return;
    if (this.detectRustFramework(filePaths, files, analysis)) return;
    if (this.detectDotnetFramework(filePaths, files, analysis)) return;
    if (this.detectElixirFramework(filePaths, files, analysis)) return;
    this.detectMobileDesktopFramework(filePaths, files, analysis);
  }

  private detectJvmFramework(filePaths: string[], files: FileMap, analysis: ProjectAnalysis): boolean {
    if (analysis.buildTool !== "maven" && analysis.buildTool !== "gradle") return false;

    const buildFile =
      filePaths.find((p) => p.endsWith("pom.xml")) ||
      filePaths.find((p) => p.includes("build.gradle"));

    if (!buildFile) return false;

    const content = this.getFileContent(files, buildFile);

    if (content.includes("spring-boot-starter")) {
      analysis.framework = "spring-boot";
      return true;
    }

    const hasWebXml = filePaths.some((p) => p.includes("web.xml"));
    const hasApplicationContext = filePaths.some((p) => p.includes("applicationContext.xml"));
    if (content.includes("spring-webmvc") || hasWebXml || hasApplicationContext) {
      analysis.framework = "spring-mvc";
      return true;
    }

    const hasSpringBootProps = filePaths.some((p) =>
      p.match(/application\.(properties|yml|yaml)$/)
    );
    if (hasSpringBootProps) {
      analysis.framework = "spring-boot";
      return true;
    }

    return false;
  }

  private detectJsFramework(filePaths: string[], files: FileMap, analysis: ProjectAnalysis): boolean {
    const pkgJsonPath = filePaths.find((p) => p.endsWith("package.json") && !p.includes("node_modules"));
    if (!pkgJsonPath) return false;

    const content = this.getFileContent(files, pkgJsonPath);
    let pkg: any = {};
    try {
      pkg = JSON.parse(content);
    } catch {
      return false;
    }

    const allDeps = {
      ...(pkg.dependencies || {}),
      ...(pkg.devDependencies || {}),
    };

    if (allDeps["next"] || filePaths.some((p) => p.match(/next\.config\.(js|ts|mjs)$/))) {
      analysis.framework = "nextjs";
      return true;
    }

    if (allDeps["nuxt"] || filePaths.some((p) => p.match(/nuxt\.config\.(js|ts)$/))) {
      analysis.framework = "nuxt";
      return true;
    }

    if (allDeps["@sveltejs/kit"] || filePaths.some((p) => p.match(/svelte\.config\.(js|ts)$/))) {
      analysis.framework = "sveltekit";
      return true;
    }

    if (allDeps["svelte"] && !allDeps["@sveltejs/kit"]) {
      analysis.framework = "svelte";
      return true;
    }

    if (allDeps["astro"] || filePaths.some((p) => p.match(/astro\.config\.(js|ts|mjs)$/))) {
      analysis.framework = "astro";
      return true;
    }

    if (allDeps["@remix-run/react"] || allDeps["@remix-run/node"]) {
      analysis.framework = "remix";
      return true;
    }

    if (allDeps["@angular/core"] || filePaths.some((p) => p.endsWith("angular.json"))) {
      analysis.framework = "angular";
      return true;
    }

    if (allDeps["@nestjs/core"]) {
      analysis.framework = "nestjs";
      return true;
    }

    if (allDeps["fastify"]) {
      analysis.framework = "fastify";
      return true;
    }

    if (allDeps["hono"]) {
      analysis.framework = "hono";
      return true;
    }

    if (allDeps["express"]) {
      analysis.framework = "express";
      return true;
    }

    if (allDeps["vue"] && !allDeps["nuxt"]) {
      analysis.framework = "vue";
      return true;
    }

    if (allDeps["react"] && !allDeps["next"] && !allDeps["@remix-run/react"]) {
      analysis.framework = "react";
      return true;
    }

    return false;
  }

  private detectPythonFramework(filePaths: string[], files: FileMap, analysis: ProjectAnalysis): boolean {
    if (!["pip", "poetry"].includes(analysis.buildTool)) {
      const hasPythonFiles = filePaths.some((p) => p.endsWith(".py"));
      if (!hasPythonFiles) return false;
    }

    if (filePaths.some((p) => p.endsWith("manage.py")) ||
        (filePaths.some((p) => p.includes("settings.py")) && filePaths.some((p) => p.includes("wsgi.py")))) {
      analysis.framework = "django";
      return true;
    }

    for (const path of filePaths) {
      if (!path.endsWith(".py")) continue;
      const content = this.getFileContent(files, path);

      if (content.includes("from fastapi") || content.includes("import fastapi")) {
        analysis.framework = "fastapi";
        return true;
      }

      if (content.includes("from flask") || content.includes("import flask") || content.includes("Flask(__name__)")) {
        analysis.framework = "flask";
        return true;
      }
    }

    const depFiles = [
      filePaths.find((p) => p.endsWith("requirements.txt")),
      filePaths.find((p) => p.endsWith("pyproject.toml")),
    ].filter(Boolean) as string[];

    for (const depFile of depFiles) {
      const content = this.getFileContent(files, depFile);
      if (content.includes("django") || content.includes("Django")) { analysis.framework = "django"; return true; }
      if (content.includes("fastapi")) { analysis.framework = "fastapi"; return true; }
      if (content.includes("flask") || content.includes("Flask")) { analysis.framework = "flask"; return true; }
    }

    return false;
  }

  private detectRubyFramework(filePaths: string[], files: FileMap, analysis: ProjectAnalysis): boolean {
    if (analysis.buildTool !== "bundler") return false;

    if (filePaths.some((p) => p.includes("config/routes.rb")) ||
        filePaths.some((p) => p.includes("app/controllers/")) ||
        filePaths.some((p) => p.includes("bin/rails"))) {
      analysis.framework = "rails";
      return true;
    }

    const gemfilePath = filePaths.find((p) => p.endsWith("Gemfile"));
    if (gemfilePath) {
      const content = this.getFileContent(files, gemfilePath);
      if (content.includes("'rails'") || content.includes('"rails"')) {
        analysis.framework = "rails";
        return true;
      }
    }

    return false;
  }

  private detectPhpFramework(filePaths: string[], files: FileMap, analysis: ProjectAnalysis): boolean {
    if (analysis.buildTool !== "composer") return false;

    const composerPath = filePaths.find((p) => p.endsWith("composer.json"));
    if (!composerPath) return false;

    const content = this.getFileContent(files, composerPath);

    if (content.includes("laravel/framework") || filePaths.some((p) => p.endsWith("artisan"))) {
      analysis.framework = "laravel";
      return true;
    }

    if (content.includes("symfony/framework-bundle") || content.includes("symfony/symfony")) {
      analysis.framework = "symfony";
      return true;
    }

    return false;
  }

  private detectGoFramework(filePaths: string[], files: FileMap, analysis: ProjectAnalysis): boolean {
    if (analysis.buildTool !== "go-mod") return false;

    const goModPath = filePaths.find((p) => p.endsWith("go.mod"));
    if (!goModPath) return false;

    const content = this.getFileContent(files, goModPath);

    if (content.includes("github.com/gin-gonic/gin")) { analysis.framework = "gin"; return true; }
    if (content.includes("github.com/gofiber/fiber")) { analysis.framework = "fiber"; return true; }
    if (content.includes("github.com/labstack/echo")) { analysis.framework = "echo-go"; return true; }

    return false;
  }

  private detectRustFramework(filePaths: string[], files: FileMap, analysis: ProjectAnalysis): boolean {
    if (analysis.buildTool !== "cargo") return false;

    const cargoPath = filePaths.find((p) => p.endsWith("Cargo.toml"));
    if (!cargoPath) return false;

    const content = this.getFileContent(files, cargoPath);

    if (content.includes("actix-web")) { analysis.framework = "actix"; return true; }
    if (content.includes("rocket")) { analysis.framework = "rocket"; return true; }
    if (content.includes("tauri")) { analysis.framework = "tauri"; return true; }

    return false;
  }

  private detectDotnetFramework(filePaths: string[], files: FileMap, analysis: ProjectAnalysis): boolean {
    if (analysis.buildTool !== "dotnet") return false;

    const csprojPath = filePaths.find((p) => p.endsWith(".csproj"));
    if (!csprojPath) return false;

    const content = this.getFileContent(files, csprojPath);

    if (content.includes("Microsoft.AspNetCore") || content.includes("Microsoft.NET.Sdk.Web")) {
      analysis.framework = filePaths.some((p) => p.includes("/Views/")) ? "dotnet-mvc" : "dotnet-webapi";
      return true;
    }

    return false;
  }

  private detectElixirFramework(filePaths: string[], files: FileMap, analysis: ProjectAnalysis): boolean {
    if (analysis.buildTool !== "mix") return false;

    const mixPath = filePaths.find((p) => p.endsWith("mix.exs"));
    if (!mixPath) return false;

    const content = this.getFileContent(files, mixPath);
    if (content.includes(":phoenix")) { analysis.framework = "phoenix"; return true; }

    return false;
  }

  private detectMobileDesktopFramework(filePaths: string[], files: FileMap, analysis: ProjectAnalysis): boolean {
    if (filePaths.some((p) => p.endsWith("pubspec.yaml"))) {
      const pubspecPath = filePaths.find((p) => p.endsWith("pubspec.yaml"));
      if (pubspecPath) {
        const content = this.getFileContent(files, pubspecPath);
        if (content.includes("flutter")) { analysis.framework = "flutter"; return true; }
      }
    }

    const pkgJsonPath = filePaths.find((p) => p.endsWith("package.json") && !p.includes("node_modules"));
    if (pkgJsonPath) {
      const content = this.getFileContent(files, pkgJsonPath);
      try {
        const pkg = JSON.parse(content);
        const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        if (allDeps["react-native"]) { analysis.framework = "react-native"; return true; }
        if (allDeps["electron"]) { analysis.framework = "electron"; return true; }
      } catch {}
    }

    return false;
  }

  private categorizeFiles(filePaths: string[], analysis: ProjectAnalysis): void {
    for (const path of filePaths) {
      if (path.endsWith(".xml") && !path.includes("pom.xml")) {
        analysis.xmlConfigs.push(path);
      }

      if (
        path.match(/Controller\.(java|ts|js|py|rb|cs|go|rs)$/) ||
        path.includes("/controller/") ||
        path.includes("/controllers/") ||
        path.includes("/Controllers/")
      ) {
        analysis.controllers.push(path);
      }

      if (
        path.match(/Service\.(java|ts|js|py|rb|cs|go|rs)$/) ||
        path.includes("/service/") ||
        path.includes("/services/") ||
        path.includes("/Services/")
      ) {
        analysis.services.push(path);
      }

      if (
        path.match(/Repository\.(java|ts|js|py|rb|cs|go|rs)$/) ||
        path.match(/Dao\.(java|ts|js|py)$/) ||
        path.includes("/repository/") ||
        path.includes("/repositories/") ||
        path.includes("/models/")
      ) {
        analysis.repositories.push(path);
      }

      if (
        path.match(/application\.(properties|yml|yaml)$/) ||
        path.match(/config\.(js|json|ts|rb|py)$/) ||
        path.match(/\.env(\..+)?$/) ||
        path.match(/appsettings(\..+)?\.json$/) ||
        path.match(/settings\.py$/) ||
        path.match(/next\.config\.(js|ts|mjs)$/) ||
        path.match(/nuxt\.config\.(js|ts)$/) ||
        path.match(/vite\.config\.(ts|js)$/) ||
        path.match(/svelte\.config\.(js|ts)$/) ||
        path.match(/astro\.config\.(mjs|js|ts)$/) ||
        path.endsWith("angular.json") ||
        path.endsWith("tsconfig.json") ||
        path.match(/tailwind\.config\.(js|ts)$/)
      ) {
        analysis.configFiles.push(path);
      }

      if (
        path.match(/[Tt]est\.(java|ts|js|tsx|jsx|py|rb|cs|go|rs)$/) ||
        path.match(/\.spec\.(ts|js|tsx|jsx)$/) ||
        path.match(/\.test\.(ts|js|tsx|jsx)$/) ||
        path.includes("/test/") ||
        path.includes("/tests/") ||
        path.includes("/__tests__/") ||
        path.includes("/spec/")
      ) {
        analysis.testFiles.push(path);
      }
    }
  }

  private detectEntryPoints(filePaths: string[], files: FileMap, analysis: ProjectAnalysis): void {
    const candidates = filePaths.filter(
      (p) =>
        p.match(/Application\.(java|ts|js)$/) ||
        p.match(/Main\.(java|ts|js|go|rs)$/) ||
        p.match(/App\.(java|ts|js|tsx|jsx|vue|svelte)$/) ||
        p.match(/index\.(ts|js|tsx|jsx)$/) ||
        p.match(/server\.(ts|js)$/) ||
        p.match(/main\.(ts|js|go|rs|py)$/) ||
        p.match(/manage\.py$/) ||
        p.match(/Program\.cs$/) ||
        p.match(/app\.py$/)
    );

    for (const candidate of candidates) {
      const content = this.getFileContent(files, candidate);
      if (
        content.includes("@SpringBootApplication") ||
        content.includes("public static void main") ||
        content.includes("app.listen") ||
        content.includes("createServer") ||
        content.includes("createApp") ||
        content.includes("Deno.serve") ||
        content.includes("func main()") ||
        content.includes("fn main()") ||
        content.includes("if __name__") ||
        content.includes("WebApplication.CreateBuilder") ||
        content.includes("Application.launch") ||
        content.includes("runApp(")
      ) {
        analysis.entryPoints.push(candidate);
      }
    }
  }

  private detectDependencies(filePaths: string[], files: FileMap, analysis: ProjectAnalysis): void {
    const pkgJsonPath = filePaths.find((p) => p.endsWith("package.json") && !p.includes("node_modules"));
    if (pkgJsonPath) {
      const content = this.getFileContent(files, pkgJsonPath);
      try {
        const pkg = JSON.parse(content);
        analysis.dependencies = [
          ...Object.keys(pkg.dependencies || {}),
          ...Object.keys(pkg.devDependencies || {}),
        ];
      } catch {}
      return;
    }

    const reqFile = filePaths.find((p) => p.endsWith("requirements.txt"));
    if (reqFile) {
      const content = this.getFileContent(files, reqFile);
      analysis.dependencies = content
        .split("\n")
        .map((line) => line.trim().split("==")[0].split(">=")[0].split("<=")[0])
        .filter(Boolean);
      return;
    }

    const gemfilePath = filePaths.find((p) => p.endsWith("Gemfile"));
    if (gemfilePath) {
      const content = this.getFileContent(files, gemfilePath);
      const gemMatches = content.match(/gem\s+['"]([^'"]+)['"]/g) || [];
      analysis.dependencies = gemMatches.map((m) => {
        const match = m.match(/gem\s+['"]([^'"]+)['"]/);
        return match ? match[1] : "";
      }).filter(Boolean);
    }
  }
}

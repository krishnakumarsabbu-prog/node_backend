import type { ProjectAnalysis } from "../types/migrationTypes";
import type { FileMap } from "../../llm/constants";
import { createScopedLogger } from "../../utils/logger";

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

    logger.info(
      `Analysis complete: framework=${analysis.framework}, buildTool=${analysis.buildTool}, files=${filePaths.length}`
    );

    return analysis;
  }

  private detectBuildTool(
    filePaths: string[],
    files: FileMap,
    analysis: ProjectAnalysis
  ): void {
    if (filePaths.some((p) => p.endsWith("pom.xml"))) {
      analysis.buildTool = "maven";
    } else if (filePaths.some((p) => p.includes("build.gradle"))) {
      analysis.buildTool = "gradle";
    } else if (filePaths.some((p) => p.endsWith("package.json"))) {
      analysis.buildTool = "npm";
    }
  }

  private detectFramework(
    filePaths: string[],
    files: FileMap,
    analysis: ProjectAnalysis
  ): void {
    const hasWebXml = filePaths.some((p) => p.includes("web.xml"));
    const hasApplicationContext = filePaths.some((p) => p.includes("applicationContext.xml"));
    const hasSpringBootProps = filePaths.some((p) =>
      p.match(/application\.(properties|yml|yaml)$/)
    );

    if (analysis.buildTool === "maven" || analysis.buildTool === "gradle") {
      const buildFile =
        filePaths.find((p) => p.endsWith("pom.xml")) ||
        filePaths.find((p) => p.includes("build.gradle"));

      if (buildFile) {
        const file = files[buildFile];
        const content = (file && 'content' in file ? file.content : "") || "";

        if (content.includes("spring-boot-starter")) {
          analysis.framework = "spring-boot";
        } else if (content.includes("spring-webmvc") || hasWebXml || hasApplicationContext) {
          analysis.framework = "spring-mvc";
        }
      }
    } else if (analysis.buildTool === "npm") {
      const pkgJson = filePaths.find((p) => p.endsWith("package.json"));
      if (pkgJson) {
        const file = files[pkgJson];
        const content = (file && 'content' in file ? file.content : "") || "";
        if (content.includes('"express"')) {
          analysis.framework = "express";
        }
      }
    }

    if (hasSpringBootProps && analysis.framework === "unknown") {
      analysis.framework = "spring-boot";
    }
  }

  private categorizeFiles(filePaths: string[], analysis: ProjectAnalysis): void {
    for (const path of filePaths) {
      if (path.endsWith(".xml") && !path.includes("pom.xml")) {
        analysis.xmlConfigs.push(path);
      }

      if (path.match(/Controller\.(java|ts|js|py)$/) || path.includes("/controller/")) {
        analysis.controllers.push(path);
      }

      if (path.match(/Service\.(java|ts|js|py)$/) || path.includes("/service/")) {
        analysis.services.push(path);
      }

      if (
        path.match(/Repository\.(java|ts|js|py)$/) ||
        path.match(/Dao\.(java|ts|js|py)$/) ||
        path.includes("/repository/")
      ) {
        analysis.repositories.push(path);
      }

      if (
        path.match(/application\.(properties|yml|yaml)$/) ||
        path.match(/config\.(js|json|ts)$/)
      ) {
        analysis.configFiles.push(path);
      }

      if (path.match(/[Tt]est\.(java|ts|js|py)$/) || path.includes("/test/")) {
        analysis.testFiles.push(path);
      }
    }
  }

  private detectEntryPoints(
    filePaths: string[],
    files: FileMap,
    analysis: ProjectAnalysis
  ): void {
    const candidates = filePaths.filter(
      (p) =>
        p.match(/Application\.(java|ts|js)$/) ||
        p.match(/Main\.(java|ts|js)$/) ||
        p.match(/App\.(java|ts|js)$/) ||
        p.match(/index\.(ts|js)$/) ||
        p.match(/server\.(ts|js)$/)
    );

    for (const candidate of candidates) {
      const file = files[candidate];
      const content = (file && 'content' in file ? file.content : "") || "";
      if (
        content.includes("@SpringBootApplication") ||
        content.includes("public static void main") ||
        content.includes("app.listen") ||
        content.includes("createServer")
      ) {
        analysis.entryPoints.push(candidate);
      }
    }
  }
}

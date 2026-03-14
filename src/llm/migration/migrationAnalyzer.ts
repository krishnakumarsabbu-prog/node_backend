import type { FileMap } from "../constants";
import type { ProjectAnalysis } from "./migrationTypes";
import { createScopedLogger } from "../../utils/logger";

const logger = createScopedLogger("migration-analyzer");

export async function analyzeProjectForMigration(files: FileMap): Promise<ProjectAnalysis> {
  logger.info("Analyzing project for migration");

  const analysis: ProjectAnalysis = {
    framework: undefined,
    buildTool: undefined,
    xmlConfigs: [],
    controllers: [],
    services: [],
    repositories: [],
    configFiles: [],
  };

  const filePaths = Object.keys(files);

  const hasPomXml = filePaths.some((path) => path.endsWith("pom.xml"));
  const hasGradleBuild = filePaths.some((path) => path.includes("build.gradle"));
  const hasWebXml = filePaths.some((path) => path.includes("web.xml"));
  const hasApplicationContext = filePaths.some((path) => path.includes("applicationContext.xml"));
  const hasApplicationProperties = filePaths.some(
    (path) => path.includes("application.properties") || path.includes("application.yml")
  );

  if (hasPomXml) {
    analysis.buildTool = "maven";
  } else if (hasGradleBuild) {
    analysis.buildTool = "gradle";
  }

  for (const path of filePaths) {
    if (path.endsWith(".xml") && !path.includes("pom.xml")) {
      analysis.xmlConfigs?.push(path);
    }

    if (path.includes("Controller.java") || path.includes("controller/")) {
      analysis.controllers?.push(path);
    }

    if (path.includes("Service.java") || path.includes("service/")) {
      analysis.services?.push(path);
    }

    if (path.includes("Repository.java") || path.includes("repository/") || path.includes("Dao.java")) {
      analysis.repositories?.push(path);
    }

    if (
      path.includes("application.properties") ||
      path.includes("application.yml") ||
      path.includes("application.yaml")
    ) {
      analysis.configFiles?.push(path);
    }
  }

  if (hasWebXml || hasApplicationContext) {
    analysis.framework = "spring-mvc";
  } else if (hasApplicationProperties) {
    const appPropsFile = filePaths.find(
      (path) => path.includes("application.properties") || path.includes("application.yml")
    );
    if (appPropsFile) {
      const content = (files[appPropsFile] as any)?.content || "";
      if (content.includes("spring.boot") || content.includes("spring-boot")) {
        analysis.framework = "spring-boot";
      }
    }
  }

  if (!analysis.framework && (hasPomXml || hasGradleBuild)) {
    const buildFile = hasPomXml
      ? filePaths.find((path) => path.endsWith("pom.xml"))
      : filePaths.find((path) => path.includes("build.gradle"));

    if (buildFile) {
      const content = (files[buildFile] as any)?.content || "";
      if (content.includes("spring-boot-starter")) {
        analysis.framework = "spring-boot";
      } else if (content.includes("spring-webmvc") || content.includes("org.springframework:spring-web")) {
        analysis.framework = "spring-mvc";
      }
    }
  }

  logger.info(`Project analysis complete: framework=${analysis.framework}, buildTool=${analysis.buildTool}`);

  return analysis;
}

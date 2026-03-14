import { exec } from "child_process";
import { promisify } from "util";
import type { BuildValidationResult, BuildTool, BuildError } from "../types/migrationTypes";
import { createScopedLogger } from "../../utils/logger";

const execAsync = promisify(exec);
const logger = createScopedLogger("verification-agent");

export class VerificationAgent {
  async validate(buildTool: BuildTool, workDir: string): Promise<BuildValidationResult> {
    logger.info(`Running build validation with ${buildTool}`);

    const command = this.getBuildCommand(buildTool);

    if (!command) {
      logger.warn(`No build command for ${buildTool}, skipping validation`);
      return {
        success: true,
        buildTool,
        errors: [],
        warnings: [],
        logs: "No build validation performed",
        exitCode: 0,
      };
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: workDir,
        timeout: 300000,
        maxBuffer: 10 * 1024 * 1024,
      });

      const logs = stdout + "\n" + stderr;
      const errors = this.parseErrors(logs, buildTool);

      const success = errors.length === 0;

      logger.info(`Build validation ${success ? "succeeded" : "failed"} with ${errors.length} errors`);

      return {
        success,
        buildTool,
        errors,
        warnings: this.parseWarnings(logs),
        logs,
        exitCode: 0,
      };
    } catch (error: any) {
      const logs = (error.stdout || "") + "\n" + (error.stderr || "");
      const errors = this.parseErrors(logs, buildTool);

      logger.error(`Build validation failed: ${errors.length} errors detected`);

      return {
        success: false,
        buildTool,
        errors,
        warnings: this.parseWarnings(logs),
        logs,
        exitCode: error.code || 1,
      };
    }
  }

  private getBuildCommand(buildTool: BuildTool): string | null {
    switch (buildTool) {
      case "maven":
        return "mvn -q -DskipTests clean package";
      case "gradle":
        return "./gradlew build -x test";
      case "npm":
        return "npm run build";
      default:
        return null;
    }
  }

  private parseErrors(logs: string, buildTool: BuildTool): BuildError[] {
    const errors: BuildError[] = [];

    switch (buildTool) {
      case "maven":
        errors.push(...this.parseMavenErrors(logs));
        break;
      case "gradle":
        errors.push(...this.parseGradleErrors(logs));
        break;
      case "npm":
        errors.push(...this.parseNpmErrors(logs));
        break;
    }

    return errors;
  }

  private parseMavenErrors(logs: string): BuildError[] {
    const errors: BuildError[] = [];
    const lines = logs.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const errorMatch = line.match(/\[ERROR\]\s+(.+?):(\d+):\s*(.+)/);
      if (errorMatch) {
        errors.push({
          file: errorMatch[1],
          line: parseInt(errorMatch[2], 10),
          message: errorMatch[3],
          type: "compilation",
        });
        continue;
      }

      if (line.includes("[ERROR]") && line.includes("Failed to execute goal")) {
        errors.push({
          message: line.replace(/\[ERROR\]\s*/, ""),
          type: "configuration",
        });
      }

      if (line.includes("cannot find symbol") || line.includes("package does not exist")) {
        errors.push({
          message: line,
          type: "compilation",
        });
      }
    }

    return errors;
  }

  private parseGradleErrors(logs: string): BuildError[] {
    const errors: BuildError[] = [];
    const lines = logs.split("\n");

    for (const line of lines) {
      const errorMatch = line.match(/(.+?\.java):(\d+):\s*error:\s*(.+)/);
      if (errorMatch) {
        errors.push({
          file: errorMatch[1],
          line: parseInt(errorMatch[2], 10),
          message: errorMatch[3],
          type: "compilation",
        });
      }

      if (line.includes("FAILURE:") || line.includes("BUILD FAILED")) {
        errors.push({
          message: line,
          type: "configuration",
        });
      }
    }

    return errors;
  }

  private parseNpmErrors(logs: string): BuildError[] {
    const errors: BuildError[] = [];
    const lines = logs.split("\n");

    for (const line of lines) {
      const tsError = line.match(/(.+?\.tsx?)\((\d+),\d+\):\s*error\s*TS\d+:\s*(.+)/);
      if (tsError) {
        errors.push({
          file: tsError[1],
          line: parseInt(tsError[2], 10),
          message: tsError[3],
          type: "compilation",
        });
      }

      if (line.includes("Module not found") || line.includes("Cannot find module")) {
        errors.push({
          message: line,
          type: "dependency",
        });
      }
    }

    return errors;
  }

  private parseWarnings(logs: string): string[] {
    const warnings: string[] = [];
    const lines = logs.split("\n");

    for (const line of lines) {
      if (line.includes("[WARNING]") || line.includes("warning:")) {
        warnings.push(line);
      }
    }

    return warnings.slice(0, 20);
  }
}

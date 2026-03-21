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
        return "mvn -B -DskipTests clean package 2>&1";
      case "gradle":
        return "./gradlew --no-daemon build -x test 2>&1";
      case "npm":
        return "npm run build 2>&1";
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

    return this.deduplicateErrors(errors);
  }

  private deduplicateErrors(errors: BuildError[]): BuildError[] {
    const seen = new Set<string>();
    return errors.filter((e) => {
      const key = `${e.file ?? ""}:${e.line ?? ""}:${e.message.slice(0, 80)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private parseMavenErrors(logs: string): BuildError[] {
    const errors: BuildError[] = [];
    const lines = logs.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const compilationMatch = line.match(/\[ERROR\]\s+(.+?\.java):\[(\d+),\d+\]\s+(.+)/);
      if (compilationMatch) {
        errors.push({
          file: compilationMatch[1].trim(),
          line: parseInt(compilationMatch[2], 10),
          message: compilationMatch[3].trim(),
          type: "compilation",
        });
        continue;
      }

      const oldFormatMatch = line.match(/\[ERROR\]\s+(.+?\.java):(\d+):\s*(.+)/);
      if (oldFormatMatch) {
        errors.push({
          file: oldFormatMatch[1].trim(),
          line: parseInt(oldFormatMatch[2], 10),
          message: oldFormatMatch[3].trim(),
          type: "compilation",
        });
        continue;
      }

      if (line.includes("[ERROR]") && line.includes("Failed to execute goal")) {
        const multiLine: string[] = [line.replace(/\[ERROR\]\s*/, "").trim()];
        let j = i + 1;
        while (j < lines.length && lines[j].trim().startsWith("->")) {
          multiLine.push(lines[j].trim());
          j++;
        }
        errors.push({
          message: multiLine.join(" "),
          type: "configuration",
        });
        continue;
      }

      if (line.includes("[ERROR]") && (
        line.includes("BeanCreationException") ||
        line.includes("NoSuchBeanDefinitionException") ||
        line.includes("UnsatisfiedDependencyException") ||
        line.includes("CircularReferenceException")
      )) {
        errors.push({
          message: line.replace(/\[ERROR\]\s*/, "").trim(),
          type: "configuration",
        });
        continue;
      }

      if (line.includes("[ERROR]") && (
        line.includes("cannot find symbol") ||
        line.includes("package does not exist") ||
        line.includes("is not abstract") ||
        line.includes("incompatible types") ||
        line.includes("method") && line.includes("not found")
      )) {
        errors.push({
          message: line.replace(/\[ERROR\]\s*/, "").trim(),
          type: "compilation",
        });
      }
    }

    return errors;
  }

  private parseGradleErrors(logs: string): BuildError[] {
    const errors: BuildError[] = [];
    const lines = logs.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      const javaCompileError = line.match(/^(.+?\.java):(\d+):\s*error:\s*(.+)/);
      if (javaCompileError) {
        errors.push({
          file: javaCompileError[1].trim(),
          line: parseInt(javaCompileError[2], 10),
          message: javaCompileError[3].trim(),
          type: "compilation",
        });
        continue;
      }

      const taskErrorMatch = line.match(/^> Task :(.+) FAILED/);
      if (taskErrorMatch) {
        const taskName = taskErrorMatch[1];
        errors.push({
          message: `Gradle task '${taskName}' failed`,
          type: "configuration",
        });
        continue;
      }

      if (line.startsWith("> ") && lines[i + 1]?.trim().startsWith("Could not resolve")) {
        errors.push({
          message: `${line.trim()} ${lines[i + 1].trim()}`,
          type: "dependency",
        });
        i++;
        continue;
      }

      if (line.includes("FAILURE:") && i + 1 < lines.length) {
        errors.push({
          message: `${line.trim()} ${(lines[i + 1] || "").trim()}`,
          type: "configuration",
        });
      }

      if (line.includes("Caused by:") && line.includes("Exception")) {
        errors.push({
          message: line.trim(),
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
        continue;
      }

      if (line.includes("Module not found") || line.includes("Cannot find module")) {
        errors.push({
          message: line.replace(/^error\s+/i, "").trim(),
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
      if (line.includes("[WARNING]") || line.match(/^\s*warning:/i)) {
        const trimmed = line.replace(/\[WARNING\]\s*/, "").trim();
        if (trimmed) warnings.push(trimmed);
      }
    }

    return warnings.slice(0, 30);
  }
}

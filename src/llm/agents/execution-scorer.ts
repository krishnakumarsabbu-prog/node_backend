import { createScopedLogger } from "../../utils/logger";
import type { PlanStep } from "../plan-processor";

const logger = createScopedLogger("execution-scorer");

export interface ExecutionScore {
  score: number;
  breakdown: {
    hasFileBlocks: number;
    hasImports: number;
    noPlaceholders: number;
    hasIntegration: number;
    noSyntaxRed: number;
  };
  passed: boolean;
  failReasons: string[];
  repairHints: string[];
}

export const PASS_THRESHOLD = 60;

const FILE_BLOCK_RE = /<cortexAction[^>]*type="file"[^>]*filePath="([^"]+)"[^>]*>/g;
const TODO_RE = /\/\/\s*TODO|\/\/\s*FIXME|placeholder|coming\s+soon/i;
const STUB_RE = /throw new Error\(['"]not implemented['"]\)|return\s+null;\s*\/\/\s*stub/i;
const ROUTE_WIRING_RE = /<Route\b|createBrowserRouter|useNavigate|<Link\s|href=["']|router\.add|app\.get|app\.post|app\.use/i;
const IMPORT_USAGE_RE = /import\s+[\w{].*?\s+from\s+['"]\.?\//;

function countFileBlocks(output: string): { count: number; paths: string[] } {
  const paths: string[] = [];
  const re = new RegExp(FILE_BLOCK_RE.source, FILE_BLOCK_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    paths.push(m[1]);
  }
  return { count: paths.length, paths };
}

export function scoreExecution(step: PlanStep, output: string): ExecutionScore {
  const failReasons: string[] = [];
  const repairHints: string[] = [];
  const breakdown = {
    hasFileBlocks: 0,
    hasImports: 0,
    noPlaceholders: 0,
    hasIntegration: 0,
    noSyntaxRed: 0,
  };

  const { count: fileCount } = countFileBlocks(output);

  if (fileCount === 0) {
    failReasons.push('NO_FILES: No <cortexAction type="file"> blocks found in output');
    repairHints.push('Output every file using <cortexAction type="file" filePath="..."> blocks');
    breakdown.hasFileBlocks = 0;
  } else {
    breakdown.hasFileBlocks = Math.min(25, 10 + fileCount * 3);
  }

  const hasImportOrExport = /\b(import|export)\b/.test(output);
  if (!hasImportOrExport && fileCount > 0) {
    failReasons.push("NO_IMPORTS: Generated files have no import/export statements");
    repairHints.push("Add proper TypeScript import/export statements to all files");
    breakdown.hasImports = 5;
  } else {
    breakdown.hasImports = 20;
  }

  const hasPlaceholders = TODO_RE.test(output) || STUB_RE.test(output);
  if (hasPlaceholders) {
    failReasons.push("PLACEHOLDER_CODE: Output contains TODO/FIXME/stub/placeholder content");
    repairHints.push("Replace all placeholder content with complete working implementations");
    breakdown.noPlaceholders = 10;
  } else {
    breakdown.noPlaceholders = 25;
  }

  const isUiStep = /component|page|view|screen|form|modal|dashboard|layout|ui\b/i.test(
    step.heading + " " + step.details,
  );
  if (isUiStep) {
    const hasWiring = ROUTE_WIRING_RE.test(output) || IMPORT_USAGE_RE.test(output);
    if (!hasWiring && fileCount > 0) {
      repairHints.push("Wire the new component into the router or import it from its parent");
      breakdown.hasIntegration = 15;
    } else {
      breakdown.hasIntegration = 20;
    }
  } else {
    breakdown.hasIntegration = 20;
  }

  const openBraces = (output.match(/\{/g) ?? []).length;
  const closeBraces = (output.match(/\}/g) ?? []).length;
  const braceDiff = Math.abs(openBraces - closeBraces);
  if (braceDiff > 20 && fileCount > 0) {
    failReasons.push("SYNTAX_RED: Large brace imbalance — output may be truncated or malformed");
    repairHints.push("Ensure all code blocks are properly closed and output is complete");
    breakdown.noSyntaxRed = 0;
  } else {
    breakdown.noSyntaxRed = 10;
  }

  const score =
    breakdown.hasFileBlocks +
    breakdown.hasImports +
    breakdown.noPlaceholders +
    breakdown.hasIntegration +
    breakdown.noSyntaxRed;

  const passed = score >= PASS_THRESHOLD && failReasons.length === 0;

  logger.info(
    `[execution-scorer] Step ${step.index} score=${score}/100 files=${fileCount} placeholders=${hasPlaceholders} braceDiff=${braceDiff} passed=${passed}`,
  );

  if (!passed) {
    logger.warn(`[execution-scorer] Step ${step.index} BELOW THRESHOLD: ${failReasons.join("; ")}`);
  }

  return { score, breakdown, passed, failReasons, repairHints };
}

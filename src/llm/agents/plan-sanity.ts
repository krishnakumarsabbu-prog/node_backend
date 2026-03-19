import { createScopedLogger } from "../../utils/logger";
import type { PlanStep } from "../plan-processor";

const logger = createScopedLogger("plan-sanity");

export interface PlanSanityResult {
  issues: PlanSanityIssue[];
  hasBlockers: boolean;
  symbolConflicts: SymbolConflict[];
}

export interface PlanSanityIssue {
  type: "FORWARD_REF" | "TRIVIAL_STEP" | "EMPTY_STEP" | "CIRCULAR_DEP";
  stepIndex: number;
  message: string;
}

export interface SymbolConflict {
  symbolName: string;
  stepIndices: number[];
  message: string;
}

const SYMBOL_PATTERNS = [
  /\binterface\s+([A-Z][A-Za-z0-9]+)\b/g,
  /\btype\s+([A-Z][A-Za-z0-9]+)\s*=/g,
  /\bclass\s+([A-Z][A-Za-z0-9]+)\b/g,
  /\bconst\s+([A-Z][A-Za-z0-9]+)\s*=/g,
  /\bfunction\s+([A-Za-z][A-Za-z0-9]+)\s*\(/g,
  /\bconst\s+([a-z][A-Za-z0-9]+)\s*=\s*(?:async\s+)?\(/g,
  /export\s+(?:default\s+)?(?:function|class|const)\s+([A-Za-z][A-Za-z0-9]+)/g,
];

function extractSymbols(text: string): string[] {
  const symbols = new Set<string>();
  for (const pattern of SYMBOL_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const name = m[1];
      if (name && name.length > 3 && !COMMON_NAMES.has(name)) {
        symbols.add(name);
      }
    }
  }
  return [...symbols];
}

const COMMON_NAMES = new Set([
  "Error", "Promise", "Array", "Object", "String", "Number", "Boolean",
  "Map", "Set", "Date", "Math", "JSON", "console", "process", "window",
  "document", "React", "Component", "Props", "State", "Node", "Event",
  "Handler", "Request", "Response", "Router", "Route", "Link", "Form",
  "Input", "Button", "Text", "View", "List", "Item", "Card", "Modal",
  "Page", "Layout", "Header", "Footer", "Sidebar", "Nav", "Menu",
  "Table", "Row", "Column", "Cell", "Icon", "Image", "Label", "Badge",
  "Alert", "Toast", "Loading", "Error", "Empty", "Success", "Wrapper",
]);

function detectForwardReferences(steps: PlanStep[]): PlanSanityIssue[] {
  const issues: PlanSanityIssue[] = [];
  const producedByStep = new Map<number, string[]>();

  for (const step of steps) {
    const symbols = extractSymbols(step.details);
    producedByStep.set(step.index, symbols);
  }

  for (const step of steps) {
    const futureSteps = steps.filter((s) => s.index > step.index);
    for (const futureStep of futureSteps) {
      const futureSymbols = producedByStep.get(futureStep.index) ?? [];
      for (const sym of futureSymbols) {
        if (sym.length > 5 && step.details.includes(sym)) {
          issues.push({
            type: "FORWARD_REF",
            stepIndex: step.index,
            message: `Step ${step.index} references "${sym}" which is defined in step ${futureStep.index}`,
          });
          break;
        }
      }
    }
  }

  return issues;
}

function detectTrivialSteps(steps: PlanStep[]): PlanSanityIssue[] {
  const issues: PlanSanityIssue[] = [];
  for (const step of steps) {
    if (step.details.trim().length < 60) {
      issues.push({
        type: "TRIVIAL_STEP",
        stepIndex: step.index,
        message: `Step ${step.index} ("${step.heading}") has nearly empty details — may produce no code`,
      });
    }
  }
  return issues;
}

function detectSymbolConflicts(steps: PlanStep[]): SymbolConflict[] {
  const symbolToSteps = new Map<string, number[]>();

  for (const step of steps) {
    const symbols = extractSymbols(step.details);
    for (const sym of symbols) {
      if (!symbolToSteps.has(sym)) {
        symbolToSteps.set(sym, []);
      }
      symbolToSteps.get(sym)!.push(step.index);
    }
  }

  const conflicts: SymbolConflict[] = [];
  for (const [sym, stepIndices] of symbolToSteps.entries()) {
    const unique = [...new Set(stepIndices)];
    if (unique.length > 1) {
      conflicts.push({
        symbolName: sym,
        stepIndices: unique,
        message: `Symbol "${sym}" appears to be defined in multiple steps: [${unique.join(", ")}] — may cause duplicate implementations`,
      });
    }
  }

  return conflicts;
}

export function runPlanSanityCheck(steps: PlanStep[]): PlanSanityResult {
  logger.info(`[plan-sanity] Running sanity check on ${steps.length} steps`);

  const forwardRefIssues = detectForwardReferences(steps);
  const trivialIssues = detectTrivialSteps(steps);
  const symbolConflicts = detectSymbolConflicts(steps);

  const allIssues = [...forwardRefIssues, ...trivialIssues];

  const hasBlockers = forwardRefIssues.length > 0;

  if (allIssues.length === 0 && symbolConflicts.length === 0) {
    logger.info(`[plan-sanity] Plan passed all sanity checks`);
  } else {
    for (const issue of allIssues) {
      if (issue.type === "FORWARD_REF") {
        logger.warn(`[plan-sanity] ${issue.message}`);
      } else {
        logger.info(`[plan-sanity] ${issue.message}`);
      }
    }
    for (const conflict of symbolConflicts) {
      logger.warn(`[plan-sanity] SYMBOL CONFLICT: ${conflict.message}`);
    }
  }

  return { issues: allIssues, hasBlockers, symbolConflicts };
}

export function injectSymbolWarningsIntoSteps(
  steps: PlanStep[],
  conflicts: SymbolConflict[],
): PlanStep[] {
  if (conflicts.length === 0) return steps;

  return steps.map((step) => {
    const relevant = conflicts.filter((c) => c.stepIndices.includes(step.index));
    if (relevant.length === 0) return step;

    const warning = relevant
      .map(
        (c) =>
          `CONSISTENCY WARNING: Symbol "${c.symbolName}" may already be defined in another step. Import it instead of redefining it.`,
      )
      .join("\n");

    return {
      ...step,
      details: `${step.details}\n\n${warning}`,
    };
  });
}

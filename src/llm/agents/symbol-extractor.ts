import type { FileMap } from "../constants";
import type { CompletedStepMemory } from "../plan-processor";

const EXPORT_PATTERN = /export\s+(?:default\s+)?(?:(?:async\s+)?function|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
const EXPORT_NAMED_PATTERN = /export\s*\{\s*([^}]+)\}/g;

function extractExports(content: string): string[] {
  const exports = new Set<string>();

  let m: RegExpExecArray | null;
  const re1 = new RegExp(EXPORT_PATTERN.source, EXPORT_PATTERN.flags);
  while ((m = re1.exec(content)) !== null) {
    if (m[1]) exports.add(m[1]);
  }

  const re2 = new RegExp(EXPORT_NAMED_PATTERN.source, EXPORT_NAMED_PATTERN.flags);
  while ((m = re2.exec(content)) !== null) {
    const names = m[1].split(",").map((n) => n.trim().split(/\s+as\s+/)[0].trim());
    for (const name of names) {
      if (name && /^[A-Za-z_$]/.test(name)) exports.add(name);
    }
  }

  return [...exports].filter((e) => e.length > 2);
}

export interface StepSymbolSummary {
  stepIndex: number;
  heading: string;
  filesWithExports: Array<{
    path: string;
    exports: string[];
  }>;
}

export function buildStepSymbolSummaries(
  completedSteps: CompletedStepMemory[],
  accumulatedFiles: FileMap,
): StepSymbolSummary[] {
  const summaries: StepSymbolSummary[] = [];

  for (const step of completedSteps) {
    const filesWithExports: Array<{ path: string; exports: string[] }> = [];

    for (const filePath of step.filesProduced) {
      const entry = accumulatedFiles[filePath];
      if (!entry || entry.type !== "file" || (entry as any).isBinary) continue;
      const content: string = (entry as any).content ?? "";
      if (!content || content.length < 20) continue;

      const exports = extractExports(content);
      if (exports.length > 0) {
        filesWithExports.push({ path: filePath, exports });
      }
    }

    if (filesWithExports.length > 0) {
      summaries.push({
        stepIndex: step.index,
        heading: step.heading,
        filesWithExports,
      });
    }
  }

  return summaries;
}

export function buildSymbolContextBlock(summaries: StepSymbolSummary[]): string {
  if (summaries.length === 0) return "";

  const lines: string[] = [
    `\n## Symbols available from previous steps (import these — do NOT redefine):`,
  ];

  for (const summary of summaries) {
    lines.push(`\n### From Step ${summary.stepIndex}: ${summary.heading}`);
    for (const { path, exports } of summary.filesWithExports) {
      const relativePath = path.replace("/home/project/", "");
      lines.push(`  ${relativePath}: ${exports.join(", ")}`);
    }
  }

  lines.push(
    ``,
    `IMPORT RULE: If you need any of the above symbols, import them. Never recreate what already exists.`,
  );

  return lines.join("\n");
}

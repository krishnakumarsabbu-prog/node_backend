import { createScopedLogger } from "../../utils/logger";
import type { FileMap } from "../constants";

const logger = createScopedLogger("completeness-checker");

export interface CompletenessReport {
  hasEntryPoint: boolean;
  orphanFiles: string[];
  missingImporters: string[];
  summary: string;
}

const ENTRY_POINT_NAMES = new Set([
  "main.tsx", "main.ts", "main.jsx", "main.js",
  "index.tsx", "index.ts", "index.jsx", "index.js",
  "App.tsx", "App.ts", "App.jsx", "App.js",
  "app.tsx", "app.ts", "app.jsx", "app.js",
  "server.ts", "server.js",
]);

const IMPORT_FROM_RE = /from\s+['"]([^'"]+)['"]/g;
const REQUIRE_RE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function getFileBasename(path: string): string {
  return path.split("/").pop() ?? "";
}

function getFileStem(path: string): string {
  const basename = getFileBasename(path);
  return basename.replace(/\.[^.]+$/, "");
}

function isSourceFile(path: string): boolean {
  return /\.[tj]sx?$/.test(path) && !path.includes("node_modules");
}

function isTestFile(path: string): boolean {
  return /\.(test|spec)\.[tj]sx?$/.test(path) || /(^|\/)(__tests__|tests?)\//i.test(path);
}

function extractImportedPaths(content: string, sourceFilePath: string): string[] {
  const dir = sourceFilePath.split("/").slice(0, -1).join("/");
  const paths: string[] = [];

  const addResolved = (importPath: string) => {
    if (!importPath.startsWith(".")) return;
    const resolved = resolveRelativePath(dir, importPath);
    if (resolved) paths.push(resolved);
  };

  let m: RegExpExecArray | null;
  const fromRe = new RegExp(IMPORT_FROM_RE.source, IMPORT_FROM_RE.flags);
  while ((m = fromRe.exec(content)) !== null) addResolved(m[1]);

  const requireRe = new RegExp(REQUIRE_RE.source, REQUIRE_RE.flags);
  while ((m = requireRe.exec(content)) !== null) addResolved(m[1]);

  return paths;
}

function resolveRelativePath(dir: string, importPath: string): string | null {
  const parts = `${dir}/${importPath}`.split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") resolved.pop();
    else if (part !== ".") resolved.push(part);
  }
  return resolved.join("/") || null;
}

function candidatePaths(path: string): string[] {
  const exts = [".ts", ".tsx", ".js", ".jsx"];
  const base = path.replace(/\.[tj]sx?$/, "");
  return [
    path,
    ...exts.map((e) => `${base}${e}`),
    ...exts.map((e) => `${path}/index${e}`),
  ];
}

export function checkCompleteness(
  accumulatedFiles: FileMap,
  originalFiles: FileMap,
): CompletenessReport {
  const originalPaths = new Set(Object.keys(originalFiles));
  const newFiles = Object.keys(accumulatedFiles).filter(
    (p) => !originalPaths.has(p) && isSourceFile(p) && !isTestFile(p),
  );

  logger.info(`[completeness-checker] Checking ${newFiles.length} new source files`);

  const hasEntryPoint = Object.keys(accumulatedFiles).some((p) =>
    ENTRY_POINT_NAMES.has(getFileBasename(p)),
  );

  if (!hasEntryPoint) {
    logger.warn(`[completeness-checker] No entry point file found in accumulated files`);
  }

  const allImportedPaths = new Set<string>();
  for (const [filePath, entry] of Object.entries(accumulatedFiles)) {
    if (!entry || entry.type !== "file" || (entry as any).isBinary) continue;
    const content: string = (entry as any).content ?? "";
    const imported = extractImportedPaths(content, filePath);
    for (const imp of imported) {
      for (const candidate of candidatePaths(imp)) {
        allImportedPaths.add(candidate);
      }
    }
  }

  const orphanFiles: string[] = [];
  const missingImporters: string[] = [];

  for (const filePath of newFiles) {
    const basename = getFileBasename(filePath);
    const stem = getFileStem(filePath);

    if (ENTRY_POINT_NAMES.has(basename)) continue;
    if (basename.startsWith("types.") || basename.startsWith("constants.") || basename.startsWith("config.")) continue;

    const isImported = candidatePaths(filePath).some((c) => allImportedPaths.has(c)) ||
      [...allImportedPaths].some((ip) => getFileStem(ip) === stem);

    if (!isImported) {
      orphanFiles.push(filePath);
      missingImporters.push(filePath);
      logger.warn(`[completeness-checker] Potential orphan: ${filePath} — no other file imports it`);
    }
  }

  const summary = buildSummary(hasEntryPoint, orphanFiles);
  logger.info(`[completeness-checker] Summary: entryPoint=${hasEntryPoint} orphans=${orphanFiles.length}`);

  return { hasEntryPoint, orphanFiles, missingImporters, summary };
}

function buildSummary(hasEntryPoint: boolean, orphanFiles: string[]): string {
  const parts: string[] = [];

  if (!hasEntryPoint) {
    parts.push("No application entry point found.");
  }

  if (orphanFiles.length > 0) {
    const names = orphanFiles.map((f) => getFileBasename(f)).join(", ");
    parts.push(`${orphanFiles.length} file(s) may not be imported anywhere: ${names}`);
  }

  if (parts.length === 0) return "All generated files appear to be connected.";
  return parts.join(" ");
}

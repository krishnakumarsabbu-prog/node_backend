import { createScopedLogger } from "../../utils/logger";
import type { FileMap } from "../constants";

const logger = createScopedLogger("completeness-checker");

export interface CompletenessReport {
  hasEntryPoint: boolean;
  orphanFiles: string[];
  missingImporters: string[];
  routingIssues: RoutingIssue[];
  serviceIssues: ServiceIssue[];
  summary: string;
}

export interface RoutingIssue {
  componentFile: string;
  message: string;
}

export interface ServiceIssue {
  serviceFile: string;
  message: string;
}

const ENTRY_POINT_NAMES = new Set([
  "main.tsx", "main.ts", "main.jsx", "main.js",
  "index.tsx", "index.ts", "index.jsx", "index.js",
  "App.tsx", "App.ts", "App.jsx", "App.js",
  "app.tsx", "app.ts", "app.jsx", "app.js",
  "server.ts", "server.js",
]);

const ROUTER_FILE_PATTERNS = [
  /router\.[tj]sx?$/i,
  /routes?\.[tj]sx?$/i,
  /App\.[tj]sx?$/i,
  /app\.[tj]sx?$/i,
  /navigation\.[tj]sx?$/i,
  /Layout\.[tj]sx?$/i,
];

const ROUTE_DECLARATION_RE = /<Route[^>]*path=|createBrowserRouter|createHashRouter|createMemoryRouter|defineRoute|router\.add\(/;
const SERVICE_CALL_HINT_RE = /useQuery|useMutation|fetch\(|axios\.|supabase\.|\.get\(|\.post\(|\.put\(|\.delete\(/;
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

function isPageOrViewFile(path: string): boolean {
  return /(page|view|screen|Page|View|Screen)\.[tj]sx?$/.test(path) ||
    /\/(pages|views|screens)\//.test(path);
}

function isServiceFile(path: string): boolean {
  return /(service|Service|api|Api|client|Client)\.[tj]sx?$/.test(path) &&
    !/\/(pages|views|screens|components)\//i.test(path);
}

function isHookFile(path: string): boolean {
  const stem = getFileStem(path);
  return stem.startsWith("use") && /[A-Z]/.test(stem[3] ?? "");
}

function getFileContent(files: FileMap, path: string): string {
  const entry = files[path];
  if (!entry || entry.type !== "file" || (entry as any).isBinary) return "";
  return (entry as any).content ?? "";
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

function buildImportGraph(files: FileMap): {
  allImportedPaths: Set<string>;
  importedBy: Map<string, string[]>;
} {
  const allImportedPaths = new Set<string>();
  const importedBy = new Map<string, string[]>();

  for (const [filePath, entry] of Object.entries(files)) {
    if (!entry || entry.type !== "file" || (entry as any).isBinary) continue;
    const content = getFileContent(files, filePath);
    const imported = extractImportedPaths(content, filePath);

    for (const imp of imported) {
      for (const candidate of candidatePaths(imp)) {
        allImportedPaths.add(candidate);
        if (!importedBy.has(candidate)) importedBy.set(candidate, []);
        importedBy.get(candidate)!.push(filePath);
      }
    }
  }

  return { allImportedPaths, importedBy };
}

function checkRouterCoverage(
  files: FileMap,
  newFiles: string[],
  originalPaths: Set<string>,
): RoutingIssue[] {
  const issues: RoutingIssue[] = [];

  const pageFiles = newFiles.filter(isPageOrViewFile);
  if (pageFiles.length === 0) return [];

  const routerFiles = Object.keys(files).filter((p) =>
    ROUTER_FILE_PATTERNS.some((re) => re.test(getFileBasename(p))),
  );

  if (routerFiles.length === 0) return [];

  const routerContent = routerFiles.map((p) => getFileContent(files, p)).join("\n");
  const hasRouteDeclarations = ROUTE_DECLARATION_RE.test(routerContent);

  if (!hasRouteDeclarations) return [];

  for (const pageFile of pageFiles) {
    const stem = getFileStem(pageFile);
    const baseName = getFileBasename(pageFile);
    const appearsInRouter = routerContent.includes(stem) || routerContent.includes(baseName);

    if (!appearsInRouter) {
      issues.push({
        componentFile: pageFile,
        message: `Page/view "${baseName}" does not appear in any router file — it may not be reachable`,
      });
      logger.warn(`[completeness-checker] ROUTING ISSUE: ${baseName} not found in router files`);
    }
  }

  return issues;
}

function checkServiceUsage(
  files: FileMap,
  newFiles: string[],
  allImportedPaths: Set<string>,
): ServiceIssue[] {
  const issues: ServiceIssue[] = [];

  const serviceAndHookFiles = newFiles.filter((p) => isServiceFile(p) || isHookFile(p));

  for (const svcFile of serviceAndHookFiles) {
    const stem = getFileStem(svcFile);
    const baseName = getFileBasename(svcFile);

    const isImported = candidatePaths(svcFile).some((c) => allImportedPaths.has(c)) ||
      [...allImportedPaths].some((ip) => getFileStem(ip) === stem);

    if (!isImported) {
      const isHook = isHookFile(svcFile);
      issues.push({
        serviceFile: svcFile,
        message: `${isHook ? "Hook" : "Service"} "${baseName}" is not imported by any file — it may be unused`,
      });
      logger.warn(`[completeness-checker] SERVICE ISSUE: ${baseName} is not imported anywhere`);
    }
  }

  return issues;
}

function checkImportGraph(
  newFiles: string[],
  allImportedPaths: Set<string>,
): string[] {
  const orphanFiles: string[] = [];

  for (const filePath of newFiles) {
    const basename = getFileBasename(filePath);
    const stem = getFileStem(filePath);

    if (ENTRY_POINT_NAMES.has(basename)) continue;
    if (
      basename.startsWith("types.") ||
      basename.startsWith("constants.") ||
      basename.startsWith("config.") ||
      basename === "tailwind.config.ts" ||
      basename === "vite.config.ts"
    ) continue;

    const isImported =
      candidatePaths(filePath).some((c) => allImportedPaths.has(c)) ||
      [...allImportedPaths].some((ip) => getFileStem(ip) === stem);

    if (!isImported) {
      orphanFiles.push(filePath);
      logger.warn(`[completeness-checker] ORPHAN: ${filePath} — no file imports it`);
    }
  }

  return orphanFiles;
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
    logger.warn(`[completeness-checker] No entry point file found`);
  }

  const { allImportedPaths } = buildImportGraph(accumulatedFiles);

  const orphanFiles = checkImportGraph(newFiles, allImportedPaths);
  const routingIssues = checkRouterCoverage(accumulatedFiles, newFiles, originalPaths);
  const serviceIssues = checkServiceUsage(accumulatedFiles, newFiles, allImportedPaths);

  const summary = buildSummary(hasEntryPoint, orphanFiles, routingIssues, serviceIssues);

  logger.info(
    `[completeness-checker] Summary: entryPoint=${hasEntryPoint} orphans=${orphanFiles.length} routingIssues=${routingIssues.length} serviceIssues=${serviceIssues.length}`,
  );

  return {
    hasEntryPoint,
    orphanFiles,
    missingImporters: orphanFiles,
    routingIssues,
    serviceIssues,
    summary,
  };
}

function buildSummary(
  hasEntryPoint: boolean,
  orphanFiles: string[],
  routingIssues: RoutingIssue[],
  serviceIssues: ServiceIssue[],
): string {
  const parts: string[] = [];

  if (!hasEntryPoint) {
    parts.push("No application entry point found.");
  }

  if (orphanFiles.length > 0) {
    const names = orphanFiles.map(getFileBasename).join(", ");
    parts.push(`${orphanFiles.length} file(s) not imported anywhere: ${names}`);
  }

  if (routingIssues.length > 0) {
    const names = routingIssues.map((i) => getFileBasename(i.componentFile)).join(", ");
    parts.push(`${routingIssues.length} page(s) not registered in router: ${names}`);
  }

  if (serviceIssues.length > 0) {
    const names = serviceIssues.map((i) => getFileBasename(i.serviceFile)).join(", ");
    parts.push(`${serviceIssues.length} service/hook(s) not used anywhere: ${names}`);
  }

  if (parts.length === 0) return "All generated files appear connected and integrated.";
  return parts.join(" ");
}

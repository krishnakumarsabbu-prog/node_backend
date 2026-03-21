import type { FileOperation } from "../types/migrationTypes";
import { createScopedLogger } from "../../utils/logger";
import { computeDiff, buildChangeSet, type FileDiff, type ChangeSet } from "./diffTracker";

const logger = createScopedLogger("migration-state");

export interface ErrorLog {
  taskId: string;
  file: string;
  error: string;
  stage: string;
  timestamp: number;
}

export interface GlobalDecisions {
  beanNames: Map<string, string>;
  packageRoot: string;
  mainClass: string | null;
  configClasses: string[];
  removedXmlFiles: string[];
  filterChainBeans: string[];
  interceptorRegistryClass: string | null;
  webMvcConfigurerClass: string | null;
  securityFilterChainBean: string | null;
  aopEnabled: boolean;
  schedulingEnabled: boolean;
  asyncEnabled: boolean;
  migratedFilters: string[];
  migratedInterceptors: string[];
  migratedAspects: string[];
}

export interface MigrationState {
  completedTasks: Set<string>;
  failedTasks: Map<string, string>;
  fileMap: Map<string, string>;
  operations: FileOperation[];
  errors: ErrorLog[];
  globalDecisions: GlobalDecisions;
  diffs: FileDiff[];
}

export function getChangeSet(state: MigrationState): ChangeSet {
  return buildChangeSet(state.diffs);
}

export function createMigrationState(sourceFiles: Map<string, string>): MigrationState {
  const fileMap = new Map<string, string>(sourceFiles);

  logger.info(`Migration state initialized with ${fileMap.size} source files`);

  return {
    completedTasks: new Set(),
    failedTasks: new Map(),
    fileMap,
    operations: [],
    errors: [],
    diffs: [],
    globalDecisions: {
      beanNames: new Map(),
      packageRoot: "",
      mainClass: null,
      configClasses: [],
      removedXmlFiles: [],
      filterChainBeans: [],
      interceptorRegistryClass: null,
      webMvcConfigurerClass: null,
      securityFilterChainBean: null,
      aopEnabled: false,
      schedulingEnabled: false,
      asyncEnabled: false,
      migratedFilters: [],
      migratedInterceptors: [],
      migratedAspects: [],
    },
  };
}

export function markTaskComplete(state: MigrationState, taskId: string): void {
  state.completedTasks.add(taskId);
}

export function markTaskFailed(state: MigrationState, taskId: string, reason: string): void {
  state.failedTasks.set(taskId, reason);
  state.errors.push({
    taskId,
    file: "",
    error: reason,
    stage: "execution",
    timestamp: Date.now(),
  });
}

export function applyFileOperation(state: MigrationState, op: FileOperation, taskId?: string): void {
  const previousContent = state.fileMap.get(op.file);

  if (op.action === "delete") {
    state.fileMap.delete(op.file);
    logger.info(`Deleted: ${op.file}`);
  } else if (op.content) {
    state.fileMap.set(op.file, op.content);
    logger.info(`${op.action === "create" ? "Created" : "Updated"}: ${op.file}`);
  }

  const enrichedOp: FileOperation = { ...op, previousContent };
  state.operations.push(enrichedOp);

  const diff = computeDiff(op.file, previousContent, op.content, op.action, taskId);
  state.diffs.push(diff);
}

export function registerBean(state: MigrationState, beanName: string, sourceFile: string): void {
  if (state.globalDecisions.beanNames.has(beanName)) {
    logger.warn(
      `Duplicate bean name detected: "${beanName}" from ${sourceFile} (already registered by ${state.globalDecisions.beanNames.get(beanName)})`
    );
  } else {
    state.globalDecisions.beanNames.set(beanName, sourceFile);
  }
}

export function serializeGlobalDecisions(state: MigrationState): string {
  const lines: string[] = [];
  lines.push(`Package Root: ${state.globalDecisions.packageRoot || "(not yet determined)"}`);
  lines.push(`Main Class: ${state.globalDecisions.mainClass || "(not yet created)"}`);
  lines.push(`Config Classes: ${state.globalDecisions.configClasses.map((f) => f.split("/").pop()).join(", ") || "(none yet)"}`);

  if (state.globalDecisions.beanNames.size > 0) {
    lines.push(`Registered Beans (${state.globalDecisions.beanNames.size}) — DO NOT re-define these:`);
    for (const [beanName, sourceFile] of state.globalDecisions.beanNames) {
      lines.push(`  • ${beanName} → ${sourceFile.split("/").pop() ?? sourceFile}`);
    }
  } else {
    lines.push(`Registered Beans: (none yet — first tasks are running)`);
  }

  if (state.globalDecisions.removedXmlFiles.length > 0) {
    lines.push(`Removed XML Files: ${state.globalDecisions.removedXmlFiles.join(", ")}`);
  }

  if (state.globalDecisions.securityFilterChainBean) {
    lines.push(`Security FilterChain Bean: ${state.globalDecisions.securityFilterChainBean} — DO NOT duplicate`);
  }
  if (state.globalDecisions.webMvcConfigurerClass) {
    lines.push(`WebMvcConfigurer: ${state.globalDecisions.webMvcConfigurerClass.split("/").pop()} — add interceptors/formatters HERE`);
  }
  if (state.globalDecisions.filterChainBeans.length > 0) {
    lines.push(`Registered FilterChain Beans: ${state.globalDecisions.filterChainBeans.join(", ")} — DO NOT duplicate`);
  }
  if (state.globalDecisions.migratedFilters.length > 0) {
    lines.push(`Migrated Filters: ${state.globalDecisions.migratedFilters.map((f) => f.split("/").pop()).join(", ")}`);
  }
  if (state.globalDecisions.migratedInterceptors.length > 0) {
    lines.push(`Migrated Interceptors: ${state.globalDecisions.migratedInterceptors.map((f) => f.split("/").pop()).join(", ")}`);
  }
  if (state.globalDecisions.migratedAspects.length > 0) {
    lines.push(`Migrated AOP Aspects: ${state.globalDecisions.migratedAspects.map((f) => f.split("/").pop()).join(", ")}`);
  }
  if (state.globalDecisions.aopEnabled) {
    lines.push(`@EnableAspectJAutoProxy: ALREADY ADDED — do not duplicate`);
  }
  if (state.globalDecisions.schedulingEnabled) {
    lines.push(`@EnableScheduling: ALREADY ADDED — do not duplicate`);
  }
  if (state.globalDecisions.asyncEnabled) {
    lines.push(`@EnableAsync: ALREADY ADDED — do not duplicate`);
  }

  lines.push(`Completed Tasks: ${state.completedTasks.size}`);
  if (state.failedTasks.size > 0) {
    lines.push(`Failed Tasks: ${state.failedTasks.size} — ${Array.from(state.failedTasks.entries()).map(([id, err]) => `${id}: ${err.slice(0, 60)}`).join("; ")}`);
  }
  const changeSet = buildChangeSet(state.diffs);
  lines.push(`Files Changed So Far: created=${changeSet.createdFiles.length} modified=${changeSet.modifiedFiles.length} deleted=${changeSet.deletedFiles.length} (+${changeSet.totalLinesAdded}/-${changeSet.totalLinesRemoved} lines)`);
  return lines.join("\n");
}

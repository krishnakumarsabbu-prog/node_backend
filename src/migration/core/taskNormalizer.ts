import type { MigrationTask, MigrationTaskCategory } from "../types/migrationTypes";
import { createScopedLogger } from "../../utils/logger";

const logger = createScopedLogger("task-normalizer");

export function normalizeTasks(tasks: MigrationTask[]): MigrationTask[] {
  const normalized: MigrationTask[] = [];
  const idSet = new Set(tasks.map((t) => t.id));

  for (const task of tasks) {
    const files = task.files && task.files.length > 0 ? task.files : [task.file];

    if (files.length <= 1 || task.type === "build") {
      normalized.push(task);
      continue;
    }

    logger.info(`Splitting task ${task.id} (${files.length} files) into per-file subtasks`);

    const subtasks: MigrationTask[] = files.map((file, idx) => {
      const subId = `${task.id}-${String(idx + 1).padStart(3, "0")}`;
      idSet.add(subId);

      return {
        id: subId,
        file,
        action: task.action ?? "create",
        description: `${task.description} — ${file.split("/").pop()}`,
        type: task.type,
        files: [file],
        dependsOn: idx === 0 ? task.dependsOn ?? [] : [`${task.id}-${String(idx).padStart(3, "0")}`],
        priority: task.priority,
      };
    });

    normalized.push(...subtasks);
  }

  const remapped = remapDependencies(tasks, normalized);

  logger.info(`Task normalization: ${tasks.length} tasks → ${remapped.length} normalized tasks`);
  return remapped;
}

function remapDependencies(
  originalTasks: MigrationTask[],
  normalizedTasks: MigrationTask[],
): MigrationTask[] {
  const originalIdToFirstSubtask = new Map<string, string>();

  for (const orig of originalTasks) {
    const files = orig.files && orig.files.length > 0 ? orig.files : [orig.file];
    if (files.length > 1 && orig.type !== "build") {
      originalIdToFirstSubtask.set(orig.id, `${orig.id}-001`);
    }
  }

  return normalizedTasks.map((task) => {
    const remappedDeps = (task.dependsOn ?? []).map((dep) => {
      return originalIdToFirstSubtask.get(dep) ?? dep;
    });

    if (remappedDeps.join(",") === (task.dependsOn ?? []).join(",")) {
      return task;
    }

    return { ...task, dependsOn: remappedDeps };
  });
}

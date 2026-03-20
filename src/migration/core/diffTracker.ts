import { createScopedLogger } from "../../utils/logger";
import type { FileOperation } from "../types/migrationTypes";

const logger = createScopedLogger("diff-tracker");

export type ChangeType = "created" | "modified" | "deleted" | "unchanged";

export interface FileDiff {
  file: string;
  changeType: ChangeType;
  linesAdded: number;
  linesRemoved: number;
  previousContent: string | undefined;
  newContent: string | undefined;
  taskId?: string;
}

export interface ChangeSet {
  diffs: FileDiff[];
  totalFilesChanged: number;
  totalLinesAdded: number;
  totalLinesRemoved: number;
  createdFiles: string[];
  modifiedFiles: string[];
  deletedFiles: string[];
}

export function computeDiff(
  file: string,
  previousContent: string | undefined,
  newContent: string | undefined,
  action: FileOperation["action"],
  taskId?: string,
): FileDiff {
  const prevLines = previousContent ? previousContent.split("\n") : [];
  const newLines = newContent ? newContent.split("\n") : [];

  let linesAdded = 0;
  let linesRemoved = 0;

  if (action === "create") {
    linesAdded = newLines.length;
    linesRemoved = 0;
  } else if (action === "delete") {
    linesAdded = 0;
    linesRemoved = prevLines.length;
  } else {
    linesAdded = Math.max(0, newLines.length - prevLines.length);
    linesRemoved = Math.max(0, prevLines.length - newLines.length);
  }

  const changeType: ChangeType =
    action === "create" ? "created" :
    action === "delete" ? "deleted" :
    "modified";

  return {
    file,
    changeType,
    linesAdded,
    linesRemoved,
    previousContent,
    newContent,
    taskId,
  };
}

export function buildChangeSet(diffs: FileDiff[]): ChangeSet {
  return {
    diffs,
    totalFilesChanged: diffs.length,
    totalLinesAdded: diffs.reduce((n, d) => n + d.linesAdded, 0),
    totalLinesRemoved: diffs.reduce((n, d) => n + d.linesRemoved, 0),
    createdFiles: diffs.filter((d) => d.changeType === "created").map((d) => d.file),
    modifiedFiles: diffs.filter((d) => d.changeType === "modified").map((d) => d.file),
    deletedFiles: diffs.filter((d) => d.changeType === "deleted").map((d) => d.file),
  };
}

export function serializeChangeSet(changeSet: ChangeSet): string {
  const lines: string[] = [];
  lines.push(`## CHANGE SET SUMMARY`);
  lines.push(`Total Files Changed: ${changeSet.totalFilesChanged}`);
  lines.push(`  Created: ${changeSet.createdFiles.length} (${changeSet.createdFiles.map((f) => f.split("/").pop()).join(", ") || "none"})`);
  lines.push(`  Modified: ${changeSet.modifiedFiles.length} (${changeSet.modifiedFiles.map((f) => f.split("/").pop()).join(", ") || "none"})`);
  lines.push(`  Deleted: ${changeSet.deletedFiles.length} (${changeSet.deletedFiles.map((f) => f.split("/").pop()).join(", ") || "none"})`);
  lines.push(`Lines Added: +${changeSet.totalLinesAdded}`);
  lines.push(`Lines Removed: -${changeSet.totalLinesRemoved}`);
  lines.push(``);
  lines.push(`## FILE DIFFS`);
  for (const diff of changeSet.diffs) {
    lines.push(`  [${diff.changeType.toUpperCase()}] ${diff.file.split("/").pop()} (+${diff.linesAdded} -${diff.linesRemoved})${diff.taskId ? ` [task: ${diff.taskId}]` : ""}`);
  }
  return lines.join("\n");
}

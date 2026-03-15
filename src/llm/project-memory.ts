// llm/project-memory.ts (Node/Express version)

import type { FileMap } from "./constants";

export type ProjectMemoryEntry = {
  projectKey: string;
  summary: string;
  architecture: string;
  latestGoal: string;
  runCount: number;
  updatedAt: string;
};

type MemoryStore = Map<string, ProjectMemoryEntry>;

const GLOBAL_MEMORY_KEY = "__cortex_project_memory_v1";
const MAX_ENTRIES = 500;
const TTL_MS = 2 * 60 * 60 * 1000;

function isExpired(entry: ProjectMemoryEntry): boolean {
  return Date.now() - new Date(entry.updatedAt).getTime() > TTL_MS;
}

function evictIfNeeded(store: MemoryStore): void {
  for (const [key, entry] of store.entries()) {
    if (isExpired(entry)) store.delete(key);
  }

  if (store.size > MAX_ENTRIES) {
    const sorted = [...store.entries()].sort(
      (a, b) => new Date(a[1].updatedAt).getTime() - new Date(b[1].updatedAt).getTime()
    );
    const toRemove = sorted.slice(0, store.size - MAX_ENTRIES);
    for (const [key] of toRemove) store.delete(key);
  }
}

/**
 * Store memory in-process (per Node worker/process).
 * NOTE: This is NOT shared across multiple Node instances/containers.
 * Entries expire after 2 hours; max 500 entries enforced.
 */
function getStore(): MemoryStore {
  const g = globalThis as typeof globalThis & {
    [GLOBAL_MEMORY_KEY]?: MemoryStore;
  };

  if (!g[GLOBAL_MEMORY_KEY]) {
    g[GLOBAL_MEMORY_KEY] = new Map<string, ProjectMemoryEntry>();
  }

  return g[GLOBAL_MEMORY_KEY] as MemoryStore;
}

/**
 * Small non-crypto hash (FNV-1a style) to derive a stable-ish key from file list.
 */
function hash(input: string): string {
  let h = 2166136261;

  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }

  return `pm_${(h >>> 0).toString(16)}`;
}

function normalizeGoal(message: string): string {
  const trimmed = (message || "").trim();

  if (!trimmed) {
    return "No explicit goal captured yet.";
  }

  return trimmed.length > 400 ? `${trimmed.slice(0, 397)}...` : trimmed;
}

function pickTopFiles(files?: FileMap): string[] {
  if (!files || typeof files !== "object") return [];

  return Object.keys(files)
    .filter((filePath) => (files as any)[filePath]?.type === "file")
    .sort()
    .slice(0, 24);
}

function inferArchitecture(files?: FileMap): string {
  const fileList = pickTopFiles(files);

  if (!fileList.length) {
    return "Architecture unknown (no file context available yet).";
  }

  const markers: string[] = [];
  const has = (value: string) => fileList.some((p) => p.toLowerCase().includes(value));

  if (has("remix") || has("app/routes")) {
    markers.push("Remix app/router structure");
  }

  if (has("vite.config") || has("vite.")) {
    markers.push("Vite-based build");
  }

  if (has("tailwind") || has("unocss")) {
    markers.push("Utility-first styling stack");
  }

  if (has("app/components/chat")) {
    markers.push("Chat-centric UI workflow");
  }

  if (has("app/lib/.server") || has("app/routes/api.")) {
    markers.push("Server-side API routes and orchestration");
  }

  const summary = markers.length ? markers.join("; ") : "General TypeScript web application";
  return `${summary}. Key files sampled: ${fileList.slice(0, 8).join(", ")}`;
}

export function deriveProjectMemoryKey(files?: FileMap): string {
  const fileList = pickTopFiles(files);
  const seed = fileList.length ? fileList.join("|") : "no-files";
  return hash(seed);
}

export function getProjectMemory(projectKey: string): ProjectMemoryEntry | null {
  return getStore().get(projectKey) || null;
}

export function upsertProjectMemory(input: {
  projectKey: string;
  files?: FileMap;
  latestGoal: string;
  summary?: string;
}): ProjectMemoryEntry {
  const store = getStore();
  const existing = store.get(input.projectKey);

  const runCount = (existing?.runCount || 0) + 1;
  const latestGoal = normalizeGoal(input.latestGoal);
  const summary = input.summary?.trim() || existing?.summary || latestGoal;
  const architecture = inferArchitecture(input.files);
  const updatedAt = new Date().toISOString();

  const entry: ProjectMemoryEntry = {
    projectKey: input.projectKey,
    summary: summary.length > 1200 ? `${summary.slice(0, 1197)}...` : summary,
    architecture: architecture.length > 1200 ? `${architecture.slice(0, 1197)}...` : architecture,
    latestGoal,
    runCount,
    updatedAt,
  };

  evictIfNeeded(store);
  store.set(input.projectKey, entry);
  return entry;
}

/**
 * Useful in unit tests to ensure clean state between runs.
 */
export function resetProjectMemoryForTests() {
  const g = globalThis as typeof globalThis & {
    [GLOBAL_MEMORY_KEY]?: MemoryStore;
  };

  g[GLOBAL_MEMORY_KEY] = new Map<string, ProjectMemoryEntry>();
}

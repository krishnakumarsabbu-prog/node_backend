import fs from "node:fs/promises";
import path from "node:path";
import { type FileMap } from "./constants";
import { extractCurrentContext } from "./utils";
import { createScopedLogger } from "../utils/logger";
import { WORK_DIR } from "../utils/constants";
import { type Message } from "ai";
import { selectContext } from "./select-context";
import { searchWithGraph, getIndex, buildIndex } from "../modules/ai_engine/agent";

const logger = createScopedLogger("search-context");

const MAX_HYBRID_FILES = 100;
const GRAPH_EXPANSION_DEPTH = 2;
const INDEX_TEMP_DIR = "/tmp/cortex-index-source";

interface SearchContextProps {
  messages: Message[];
  files: FileMap;
  summary: string;
  onFinish?: (resp: any) => void;
}

let materializePromise: Promise<void> | null = null;

function toRelPath(filePath: string): string {
  const prefix = WORK_DIR.endsWith("/") ? WORK_DIR : WORK_DIR + "/";
  if (filePath.startsWith(prefix)) {
    return filePath.slice(prefix.length);
  }
  if (filePath.startsWith("/")) {
    return filePath.slice(1);
  }
  return filePath;
}

async function materializeFileMapToDisk(files: FileMap): Promise<void> {
  if (materializePromise) {
    return materializePromise;
  }

  materializePromise = (async () => {
    try {
      await fs.rm(INDEX_TEMP_DIR, { recursive: true, force: true });
      await fs.mkdir(INDEX_TEMP_DIR, { recursive: true });

      const writeOps: Promise<void>[] = [];
      let queued = 0;

      for (const [filePath, entry] of Object.entries(files)) {
        if (!entry || entry.type !== "file" || entry.isBinary) continue;

        const relPath = toRelPath(filePath);

        if (!relPath || relPath.startsWith("/")) {
          logger.warn(`materializeFileMapToDisk: skipping suspicious path "${filePath}"`);
          continue;
        }

        const dest = path.join(INDEX_TEMP_DIR, relPath);
        const dir = path.dirname(dest);

        writeOps.push(
          fs.mkdir(dir, { recursive: true })
            .then(() => fs.writeFile(dest, entry.content || "", "utf-8"))
            .catch((err) => { logger.warn(`Failed to write ${relPath}:`, err); })
        );
        queued++;
      }

      await Promise.allSettled(writeOps);
      logger.info(`materializeFileMapToDisk: queued ${queued} files to ${INDEX_TEMP_DIR}`);
    } catch (err) {
      logger.error("materializeFileMapToDisk failed:", err);
      throw err;
    } finally {
      materializePromise = null;
    }
  })();

  return materializePromise;
}

function buildQueryVariants(userQuestion: string): string[] {
  const base = userQuestion.trim();
  const variants: string[] = [base];

  const tokens = base.split(/\W+/).filter((t) => t.length > 2);
  if (tokens.length > 3) {
    const firstHalf = tokens.slice(0, Math.ceil(tokens.length / 2)).join(" ");
    const secondHalf = tokens.slice(Math.floor(tokens.length / 2)).join(" ");
    if (firstHalf !== base) variants.push(firstHalf);
    if (secondHalf !== base && secondHalf !== firstHalf) variants.push(secondHalf);
  }

  const actionWords = new Set(["implement", "create", "update", "fix", "refactor", "add", "remove", "modify", "build"]);
  const withoutActions = base
    .split(" ")
    .filter((w) => !actionWords.has(w.toLowerCase()))
    .join(" ");
  if (withoutActions !== base && withoutActions.trim().length > 5) {
    variants.push(withoutActions);
  }

  return [...new Set(variants)];
}

export async function searchContext(props: SearchContextProps): Promise<FileMap> {
  const { messages, files, summary, onFinish } = props;

  const { codeContext } = extractCurrentContext(messages);

  const currentFiles: string[] = [];
  const contextFiles: FileMap = {};

  if (codeContext?.type === "codeContext") {
    const codeContextFiles: string[] = codeContext.files;

    Object.keys(files || {}).forEach((fullPath) => {
      const relPath = toRelPath(fullPath);

      if (codeContextFiles.includes(relPath)) {
        contextFiles[relPath] = (files as any)[fullPath];
        currentFiles.push(relPath);
      }
    });
  }

  const lastUserMessage = messages.filter((x) => x.role === "user").pop();
  if (!lastUserMessage) {
    logger.warn("searchContext: no user message found, returning existing context");
    return contextFiles;
  }

  const extractTextContent = (message: Message) =>
    Array.isArray(message.content)
      ? ((message.content as any[]).find((item) => item.type === "text")?.text as string) || ""
      : (message.content as string) || "";

  const userQuestion = extractTextContent(lastUserMessage);

  try {
    if (!getIndex()) {
      logger.info("searchContext: no index, materializing file map to disk then building index...");
      await materializeFileMapToDisk(files);
      try {
        buildIndex(INDEX_TEMP_DIR);
      } catch (buildErr) {
        logger.error("searchContext: index build failed:", buildErr);
        throw buildErr;
      }
    }

    const queryVariants = buildQueryVariants(userQuestion);
    const seenPaths = new Set<string>(currentFiles);
    const relevantPaths: string[] = [];

    for (const variant of queryVariants) {
      if (relevantPaths.length >= MAX_HYBRID_FILES) break;
      const batchSize = Math.ceil(MAX_HYBRID_FILES / queryVariants.length);
      const found = searchWithGraph(variant, batchSize, GRAPH_EXPANSION_DEPTH);
      for (const p of found) {
        if (!seenPaths.has(p)) {
          seenPaths.add(p);
          relevantPaths.push(p);
          if (relevantPaths.length >= MAX_HYBRID_FILES) break;
        }
      }
    }

    logger.info(`searchContext (hybrid multi-pass): found ${relevantPaths.length} unique relevant paths across ${queryVariants.length} query variants`);

    const newFiles: FileMap = {};
    for (const indexRelPath of relevantPaths) {
      const candidates = [
        `${WORK_DIR}/${indexRelPath}`,
        indexRelPath,
        `/${indexRelPath}`,
      ];

      let found = false;
      for (const candidate of candidates) {
        const entry = (files as any)[candidate];
        if (entry) {
          newFiles[indexRelPath] = entry;
          found = true;
          break;
        }
      }

      if (!found) {
        logger.debug(`searchContext: no FileMap entry for index path "${indexRelPath}"`);
      }
    }

    const totalFiles = Object.keys(newFiles).length;

    if (totalFiles > 0) {
      return { ...contextFiles, ...newFiles };
    }

    logger.info("searchContext (hybrid): no results, falling back to LLM selectContext");
  } catch (error) {
    logger.error("searchContext (hybrid) failed, falling back to LLM selectContext:", error);
  }

  try {
    const llmFiles = await selectContext({
      messages,
      files,
      summary,
      onFinish,
    });

    logger.info(`searchContext (LLM fallback): got ${Object.keys(llmFiles || {}).length} files`);
    return llmFiles || contextFiles;
  } catch (fallbackError) {
    logger.error("searchContext (LLM fallback) also failed:", fallbackError);
    return contextFiles;
  }
}

export function getFilePaths(files: FileMap) {
  return Object.keys(files || {});
}

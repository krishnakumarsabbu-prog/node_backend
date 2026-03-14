import fs from "node:fs";
import path from "node:path";
import { type FileMap } from "./constants";
import { extractCurrentContext } from "./utils";
import { createScopedLogger } from "../utils/logger";
import { WORK_DIR } from "../utils/constants";
import { type Message } from "ai";
import { selectContext } from "./select-context";
import { searchWithGraph, getIndex, buildIndex } from "../modules/ai_engine/agent";

const logger = createScopedLogger("search-context");

const MAX_HYBRID_FILES = 5;
const INDEX_TEMP_DIR = "/tmp/cortex-index-source";

interface SearchContextProps {
  messages: Message[];
  files: FileMap;
  summary: string;
  onFinish?: (resp: any) => void;
}

function materializeFileMapToDisk(files: FileMap): void {
  try {
    fs.rmSync(INDEX_TEMP_DIR, { recursive: true, force: true });
    fs.mkdirSync(INDEX_TEMP_DIR, { recursive: true });

    let written = 0;
    for (const [filePath, entry] of Object.entries(files)) {
      if (!entry || entry.type !== "file" || entry.isBinary) continue;

      const relPath = filePath.startsWith(WORK_DIR + "/")
        ? filePath.replace(WORK_DIR + "/", "")
        : filePath.startsWith("/")
          ? filePath.slice(1)
          : filePath;

      const dest = path.join(INDEX_TEMP_DIR, relPath);
      const dir = path.dirname(dest);

      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(dest, entry.content || "", "utf-8");
        written++;
      } catch {
        // skip files that fail to write
      }
    }

    logger.info(`materializeFileMapToDisk: wrote ${written} files to ${INDEX_TEMP_DIR}`);
  } catch (err) {
    logger.error("materializeFileMapToDisk failed:", err);
    throw err;
  }
}

export async function searchContext(props: SearchContextProps): Promise<FileMap> {
  const { messages, files, summary, onFinish } = props;

  const { codeContext } = extractCurrentContext(messages);

  const currentFiles: string[] = [];
  const contextFiles: FileMap = {};

  if (codeContext?.type === "codeContext") {
    const codeContextFiles: string[] = codeContext.files;

    Object.keys(files || {}).forEach((fullPath) => {
      const relPath = fullPath.startsWith(`${WORK_DIR}/`)
        ? fullPath.replace(`${WORK_DIR}/`, "")
        : fullPath;

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
      materializeFileMapToDisk(files);
      buildIndex(INDEX_TEMP_DIR);
    }

    const relevantPaths: string[] = searchWithGraph(userQuestion, MAX_HYBRID_FILES, 1);

    const newFiles: FileMap = {};
    for (const relPath of relevantPaths) {
      if (currentFiles.includes(relPath)) continue;

      const fullPath = `${WORK_DIR}/${relPath}`;
      const entry = (files as any)[fullPath] || (files as any)[relPath];
      if (entry) {
        newFiles[relPath] = entry;
      }
    }

    const totalFiles = Object.keys(newFiles).length;
    logger.info(`searchContext (hybrid): found ${totalFiles} new relevant files`);

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

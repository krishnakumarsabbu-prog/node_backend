import { type FileMap } from "./constants";
import { extractCurrentContext } from "./utils";
import { createScopedLogger } from "../utils/logger";
import { type Message } from "ai";
import { selectContext } from "./select-context";
import { searchWithGraph, getIndex, buildIndex } from "../modules/ai_engine/agent";

const logger = createScopedLogger("search-context");

const MAX_HYBRID_FILES = 5;

interface SearchContextProps {
  messages: Message[];
  files: FileMap;
  summary: string;
  onFinish?: (resp: any) => void;
}

export async function searchContext(props: SearchContextProps): Promise<FileMap> {
  const { messages, files, summary, onFinish } = props;

  const { codeContext } = extractCurrentContext(messages);

  const currentFiles: string[] = [];
  const contextFiles: FileMap = {};

  if (codeContext?.type === "codeContext") {
    const codeContextFiles: string[] = codeContext.files;

    Object.keys(files || {}).forEach((fullPath) => {
      const relPath = fullPath.startsWith("/home/project/")
        ? fullPath.replace("/home/project/", "")
        : fullPath;

      if (codeContextFiles.includes(relPath)) {
        contextFiles[relPath] = (files as any)[fullPath];
        currentFiles.push(relPath);
      }
    });
  }

  const lastUserMessage = messages.filter((x) => x.role === "user").pop();
  if (!lastUserMessage) throw new Error("No user message found");

  const extractTextContent = (message: Message) =>
    Array.isArray(message.content)
      ? ((message.content as any[]).find((item) => item.type === "text")?.text as string) || ""
      : (message.content as any);

  const userQuestion = extractTextContent(lastUserMessage);

  try {
    if (!getIndex()) {
      logger.info("searchContext (hybrid): no index found, building from file map...");
      buildIndexFromFileMap(files);
    }

    const relevantPaths: string[] = searchWithGraph(userQuestion, MAX_HYBRID_FILES, 1);

    const newFiles: FileMap = {};
    for (const relPath of relevantPaths) {
      if (currentFiles.includes(relPath)) continue;

      const fullPath = `/home/project/${relPath}`;
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

function buildIndexFromFileMap(files: FileMap): void {
  try {
    const tempDir = "/tmp/cortex-index-source";
    buildIndex(tempDir);
  } catch (err) {
    logger.warn("Failed to build AI engine index from file map:", err);
  }
}

export function getFilePaths(files: FileMap) {
  return Object.keys(files || {});
}
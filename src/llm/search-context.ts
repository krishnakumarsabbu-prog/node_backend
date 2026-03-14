import { type FileMap } from "./constants";
import { extractCurrentContext } from "./utils";
import { createScopedLogger } from "../utils/logger";
import { type Message } from "ai";
import { selectContext } from "./select-context";

const logger = createScopedLogger("search-context");

interface SearchContextProps {
  messages: Message[];
  files: FileMap;
  summary: string;
  onFinish?: (resp: any) => void;
}

export async function searchContext(props: SearchContextProps): Promise<FileMap> {
  const { messages, files, summary, onFinish } = props;

  // — Rebuild the existing context buffer from the last codeContext annotation —
  const { codeContext } = extractCurrentContext(messages);

  const currentFiles: string[] = [];    // relative paths already in context
  const contextFiles: FileMap = {};      // full map of those files (relative key -> content)

  if (codeContext?.type === "codeContext") {
    const codeContextFiles: string[] = codeContext.files;

    Object.keys(files || {}).forEach((fullPath) => {
      // fullPath = "/home/project/src/foo.ts"
      // relPath = "src/foo.ts"
      const relPath = fullPath.startsWith("/home/project/")
        ? fullPath.replace("/home/project/", "")
        : fullPath;

      if (codeContextFiles.includes(relPath)) {
        contextFiles[relPath] = (files as any)[fullPath];
        currentFiles.push(relPath);
      }
    });
  }

  // — Extract the user's latest question —
  const lastUserMessage = messages.filter((x) => x.role === "user").pop();
  if (!lastUserMessage) throw new Error("No user message found");

  const extractTextContent = (message: Message) =>
    Array.isArray(message.content)
      ? ((message.content as any[]).find((item) => item.type === "text")?.text as string) || ""
      : (message.content as any);

  const userQuestion = extractTextContent(lastUserMessage);

//   // — Try hybrid search first (0 tokens) —
//   try {
//     const { searchContext: aiEngineSearch } = await import("../modules/ai_engine/api.ts");

//     const newFiles: FileMap = aiEngineSearch({
//       question: userQuestion,
//       files: files as any, // full-path keyed map { "/home/project/...": content }
//       currentFiles,        // relative paths already in buffer ["src/foo.ts"]
//       maxFiles: 5,
//     }) as unknown as FileMap;

//     const totalFiles = Object.keys(newFiles).length;
//     logger.info(`searchContext (hybrid): found ${totalFiles} new relevant files`);

//     if (totalFiles > 0) {
//       // Merge new files with already-in-context files and return
//       return { ...contextFiles, ...newFiles };
//     }

//     // — Hybrid search returned nothing - fall back to LLM selectContext —
//     logger.info("searchContext (hybrid): no results, falling back to LLM selectContext");
//   } catch (error) {
//     logger.error("searchContext (hybrid) failed, falling back to LLM selectContext:", error);
//   }

  // — Fallback: LLM-based selectContext (uses tokens but is more thorough) —
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
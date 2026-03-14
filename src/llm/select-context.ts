import { generateText, type CoreTool, type GenerateTextResult, type Message } from "ai";
import ignore from "ignore";

import { IGNORE_PATTERNS, type FileMap } from "./constants";
import {
  createFilesContext,
  extractCurrentContext,
  simplifyCortexActions,
} from "./utils";
import { createScopedLogger } from "../utils/logger";
import { getTachyonModel } from "../modules/llm/providers/tachyon";

const ig = ignore().add(IGNORE_PATTERNS);
const logger = createScopedLogger("select-context");

export async function selectContext(props: {
  messages: Message[];
  files: FileMap;
  summary: string;
  onFinish?: (resp: GenerateTextResult<Record<string, CoreTool<any, any>>, never>) => void;
}) {
  const { messages, files, summary, onFinish } = props;

  // Clean up messages (remove cortex thoughts + simplify actions)
  const processedMessages = messages.map((message) => {
    if (message.role === "assistant") {
      let content = message.content as any;

      if (typeof content === "string") {
        content = simplifyCortexActions(content);
        content = content.replace(/<div class=\\"__cortexThought__\\">.*?<\/div>/s, "");
        content = content.replace(/<think>.*?<\/think>/s, "");
      }

      return { ...message, content };
    }

    return message;
  });

  const { codeContext } = extractCurrentContext(processedMessages);

  // All file paths (filtered by ignore)
  let filePaths = getFilePaths(files || {});

  // Build "current context buffer" text from codeContext annotation
  let context = "";
  const currentFiles: string[] = [];
  const contextFiles: FileMap = {};

  if (codeContext?.type === "codeContext") {
    const codeContextFiles: string[] = codeContext.files;

    Object.keys(files || {}).forEach((path) => {
      let relativePath = path;

      if (path.startsWith("/home/project/")) {
        relativePath = path.replace("/home/project/", "");
      }

      if (codeContextFiles.includes(relativePath)) {
        // IMPORTANT: in original code, contextFiles uses relativePath as key
        contextFiles[relativePath] = (files as any)[path];
        currentFiles.push(relativePath);
      }
    });

    context = createFilesContext(contextFiles);
  }

  const summaryText = `Here is the summary of the chat till now: ${summary}`;

  const extractTextContent = (message: Message) =>
    Array.isArray(message.content)
      ? ((message.content as any[]).find((item) => item.type === "text")?.text as string) || ""
      : (message.content as any);

  const lastUserMessage = processedMessages.filter((x) => x.role === "user").pop();
  if (!lastUserMessage) throw new Error("No user message found");

  // Ask Tachyon to choose context changes (include/exclude)
  const resp = await generateText({
    model: getTachyonModel(),

    system: `
You are a software engineer. You are working on a project. You have access to the following files:

AVAILABLE FILES PATHS
---
${filePaths.map((path) => `- ${path}`).join("\n")}
---

You have following code loaded in the context buffer that you can refer to:

CURRENT CONTEXT BUFFER
---
${context}
---

Now, you are given a task. You need to select the files that are relevant to the task from the list of files above.

RESPONSE FORMAT:
Your response should be in following format:

---
<updateContextBuffer>
  <includeFile path="path/to/file"/>
  <excludeFile path="path/to/file"/>
</updateContextBuffer>
---

RULES:
* Your response MUST start with <updateContextBuffer> and end with </updateContextBuffer>.
* You can include multiple <includeFile> and <excludeFile> tags.
* Do not include any other text.
* Do not include any file not in AVAILABLE FILES PATHS.
* Do not include any file already in the context buffer.
* If no changes are needed, return empty updateContextBuffer.
    `,

    prompt: `
${summaryText}

Users Question: ${extractTextContent(lastUserMessage)}

Update the context buffer with the files that are relevant to the task.

CRITICAL RULES:
* Only include relevant files.
* Context buffer is expensive: include only absolutely necessary files.
* Only 5 files can be placed in the context buffer at a time.
* If buffer is full, exclude files that are not needed and include relevant ones.
* If no changes are needed, return empty updateContextBuffer.
    `,
  });

  if (onFinish) onFinish(resp);

  const response = resp.text || "";
  const updateContextBuffer = response.match(/<updateContextBuffer>([\s\S]*?)<\/updateContextBuffer>/);

  if (!updateContextBuffer) {
    logger.error("selectContext invalid response:", response);
    throw new Error("Invalid response. Please follow the response format");
  }

  const includeFiles =
    updateContextBuffer[1]
      .match(/<includeFile path="(.*?)"/gm)
      ?.map((x) => x.replace('<includeFile path="', "").replace('"', "")) || [];

  const excludeFiles =
    updateContextBuffer[1]
      .match(/<excludeFile path="(.*?)"/gm)
      ?.map((x) => x.replace('<excludeFile path="', "").replace('"', "")) || [];

  // Apply exclusions to current contextFiles
  excludeFiles.forEach((path) => {
    delete (contextFiles as any)[path];
  });

  // Now build filteredFiles from included files (relative paths)
  const filteredFiles: FileMap = {};

  includeFiles.forEach((path) => {
    // Normalize to full path for lookup in `files`
    const fullPath = path.startsWith("/home/project/") ? path : `/home/project/${path}`;

    if (!filePaths.includes(fullPath)) {
      logger.error(`File ${path} is not in AVAILABLE FILES PATHS`);
      return;
    }

    // If already in context, skip
    if (currentFiles.includes(path)) return;

    // Store relative path as key (same as original)
    filteredFiles[path] = (files as any)[fullPath];
  });

  const totalFiles = Object.keys(filteredFiles).length;
  logger.info(`selectContext picked files: ${totalFiles}`);

  if (totalFiles === 0) {
    throw new Error("cortex failed to select files");
  }

  return filteredFiles;
}

export function getFilePaths(files: FileMap) {
  let filePaths = Object.keys(files || {});
  filePaths = filePaths.filter((x) => {
    const relPath = x.replace("/home/project/", "");
    return !ig.ignores(relPath);
  });
  return filePaths;
}
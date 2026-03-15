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

const MAX_CONTEXT_FILES = 100;
const BATCH_SIZE = 40;

export async function selectContext(props: {
  messages: Message[];
  files: FileMap;
  summary: string;
  onFinish?: (resp: GenerateTextResult<Record<string, CoreTool<any, any>>, never>) => void;
}) {
  const { messages, files, summary, onFinish } = props;

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

  let filePaths = getFilePaths(files || {});

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

  const userQuestion = extractTextContent(lastUserMessage);

  const newPaths = filePaths.filter((p) => {
    const rel = p.startsWith("/home/project/") ? p.replace("/home/project/", "") : p;
    return !currentFiles.includes(rel);
  });

  const prioritized = prioritizePaths(newPaths, userQuestion);
  const batches = chunkArray(prioritized, BATCH_SIZE);

  const allIncluded: string[] = [];
  const allExcluded: string[] = [];

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];
    const remaining = MAX_CONTEXT_FILES - allIncluded.length;
    if (remaining <= 0) break;

    const resp = await generateText({
      model: getTachyonModel(),
      system: `
You are a software engineer. You are working on a project. You have access to the following files:

AVAILABLE FILES PATHS
---
${batch.map((path) => `- ${path}`).join("\n")}
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
* You may include up to ${remaining} files in this batch.
      `,

      prompt: `
${summaryText}

Users Question: ${userQuestion}

Update the context buffer with the files that are relevant to the task.

CRITICAL RULES:
* Only include relevant files.
* You may include up to ${remaining} files from this batch.
* If buffer is full, exclude files that are not needed and include relevant ones.
* If no changes are needed, return empty updateContextBuffer.
      `,
    });

    if (batchIdx === batches.length - 1 && onFinish) onFinish(resp);

    const response = resp.text || "";
    const updateContextBuffer = response.match(/<updateContextBuffer>([\s\S]*?)<\/updateContextBuffer>/);

    if (!updateContextBuffer) {
      logger.warn(`selectContext batch ${batchIdx} invalid response, skipping`);
      continue;
    }

    const includeFiles =
      updateContextBuffer[1]
        .match(/<includeFile path="(.*?)"/gm)
        ?.map((x) => x.replace('<includeFile path="', "").replace('"', "")) || [];

    const excludeFiles =
      updateContextBuffer[1]
        .match(/<excludeFile path="(.*?)"/gm)
        ?.map((x) => x.replace('<excludeFile path="', "").replace('"', "")) || [];

    allIncluded.push(...includeFiles);
    allExcluded.push(...excludeFiles);
  }

  excludeFiles(allExcluded, contextFiles);

  const filteredFiles: FileMap = {};

  allIncluded.forEach((path) => {
    const fullPath = path.startsWith("/home/project/") ? path : `/home/project/${path}`;

    if (!filePaths.includes(fullPath) && !filePaths.includes(path)) {
      logger.error(`File ${path} is not in AVAILABLE FILES PATHS`);
      return;
    }

    if (currentFiles.includes(path)) return;

    filteredFiles[path] = (files as any)[fullPath] || (files as any)[path];
  });

  const totalFiles = Object.keys(filteredFiles).length;
  logger.info(`selectContext picked files: ${totalFiles}`);

  if (totalFiles === 0) {
    throw new Error("cortex failed to select files");
  }

  return filteredFiles;
}

function excludeFiles(paths: string[], contextFiles: FileMap) {
  for (const path of paths) {
    delete (contextFiles as any)[path];
  }
}

function prioritizePaths(paths: string[], query: string): string[] {
  const queryLower = query.toLowerCase();
  const queryTokens = queryLower.split(/\W+/).filter((t) => t.length > 2);

  const scored = paths.map((p) => {
    const relPath = p.startsWith("/home/project/") ? p.replace("/home/project/", "") : p;
    const parts = relPath.toLowerCase().split(/[/._-]/);
    let score = 0;

    for (const token of queryTokens) {
      if (parts.some((part) => part.includes(token))) score += 30;
    }

    const ext = relPath.split(".").pop() || "";
    const highValueExts = new Set(["ts", "tsx", "js", "jsx", "py", "go", "rs", "java", "cs", "vue", "svelte"]);
    if (highValueExts.has(ext)) score += 10;

    const lowValuePatterns = [/test\./i, /spec\./i, /\.d\.ts$/, /node_modules/, /\.min\./, /lock\.json$/];
    if (lowValuePatterns.some((r) => r.test(relPath))) score -= 20;

    if (/index\.(ts|tsx|js|jsx)$/.test(relPath)) score += 15;
    if (/\/(components|pages|routes|api|services|hooks|utils|lib)\//i.test(relPath)) score += 10;

    return { path: p, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.path);
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

export function getFilePaths(files: FileMap) {
  let filePaths = Object.keys(files || {});
  filePaths = filePaths.filter((x) => {
    const relPath = x.replace("/home/project/", "");
    return !ig.ignores(relPath);
  });
  return filePaths;
}

import { convertToCoreMessages, streamText as _streamText, type Message } from "ai";

import type { FileMap } from "./constants";
import { createScopedLogger } from "../utils/logger";
import { createFilesContext } from "./utils";
import type { DesignScheme } from "../types/design-scheme";

import { WORK_DIR, MODIFICATIONS_TAG_NAME } from "../utils/constants";
import { PromptLibrary } from "./common/prompt-library";
import { getSystemPrompt } from "../prompts/prompts";
import { getTachyonModel } from "../modules/llm/providers/tachyon";
import { discussPrompt } from "./common/prompts/discuss-prompt";

export type Messages = Message[];

export const allowedHTMLElements = [
  'a',
  'b',
  'button',
  'blockquote',
  'br',
  'code',
  'dd',
  'del',
  'details',
  'div',
  'dl',
  'dt',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'ins',
  'kbd',
  'li',
  'ol',
  'p',
  'pre',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'source',
  'span',
  'strike',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
  'var',
  'think',
  'header',
];

export interface StreamingOptions extends Omit<Parameters<typeof _streamText>[0], "model"> {
  supabaseConnection?: {
    isConnected: boolean;
    hasSelectedProject: boolean;
    credentials?: {
      anonKey?: string;
      supabaseUrl?: string;
    };
  };
}

const logger = createScopedLogger("stream-text");

const LOCK_FILE_PATTERN = /^<cortexAction[^>]*\bfilePath="[^"]*(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|composer\.lock|Gemfile\.lock|Cargo\.lock|poetry\.lock|go\.sum|shrinkwrap\.json)"[^>]*>[\s\S]*?<\/cortexAction>/gm;

function sanitizeText(text: string): string {
  let sanitized = text.replace(/<div class="__cortexThought__">.*?<\/div>/s, "");
  sanitized = sanitized.replace(/<think>.*?<\/think>/s, "");
  sanitized = sanitized.replace(LOCK_FILE_PATTERN, "");
  return sanitized.trim();
}

export async function streamText(props: {
  messages: Omit<Message, "id">[];
  options?: StreamingOptions;

  files?: FileMap;
  contextOptimization?: boolean;
  contextFiles?: FileMap;
  summary?: string;
  messageSliceId?: number;

  chatMode?: "discuss" | "build" | "migrate";
  designScheme?: DesignScheme;

  apiKeys?: Record<string, string>;
  providerSettings?: any;
  promptId?: string;
  env?: any;
  clientAbortSignal?: AbortSignal;
  systemSuffix?: string;
}) {
  const {
    messages,
    options,
    files,
    contextOptimization,
    contextFiles,
    summary,
    chatMode,
    designScheme,
    promptId,
    clientAbortSignal,
    systemSuffix,
  } = props;

  let processedMessages = messages.map((message: any) => {
    const newMessage = { ...message };

    if (message.role === "user" && typeof message.content === "string") {
      newMessage.content = sanitizeText(message.content);
    } else if (message.role === "assistant" && typeof message.content === "string") {
      newMessage.content = sanitizeText(message.content);
    }

    if (Array.isArray(message.parts)) {
      newMessage.parts = message.parts.map((part: any) =>
        part.type === "text" ? { ...part, text: sanitizeText(part.text) } : part,
      );
    }

    return newMessage;
  });

  let systemPrompt =
    PromptLibrary.getPromptFromLibrary(promptId || "default", {
      cwd: WORK_DIR,
      allowedHtmlElements: allowedHTMLElements,
      modificationTagName: MODIFICATIONS_TAG_NAME,
      designScheme,
      supabase: {
        isConnected: options?.supabaseConnection?.isConnected || false,
        hasSelectedProject: options?.supabaseConnection?.hasSelectedProject || false,
        credentials: options?.supabaseConnection?.credentials || undefined,
      },
    }) ?? getSystemPrompt();

  if (systemSuffix) {
    systemPrompt = `${systemPrompt}\n\n${systemSuffix}`;
  }

  const isPlanMode = promptId === "plan" || promptId === "plan-test";
  const isMigrationMode = promptId === "migration";

  const shouldInjectContext = contextFiles && (
    (chatMode === "build" && contextOptimization) ||
    isPlanMode ||
    isMigrationMode
  );

  if (shouldInjectContext) {
    const { totalChars, oversizedFiles } = estimateContextSize(contextFiles!);
    let effectiveContextFiles = contextFiles!;

    const contextFileKeys = Object.keys(contextFiles!);
    logger.info(
      `[stream-text] CONTEXT BUFFER: ${contextFileKeys.length} file(s), ${Math.round(totalChars / 1000)}k chars, promptId=${promptId ?? "default"}, isPlanMode=${isPlanMode}`,
    );
    for (const fp of contextFileKeys) {
      const entry = (contextFiles as any)![fp];
      const chars = typeof entry?.content === "string" ? entry.content.length : 0;
      logger.info(`[stream-text]   ↳ ${fp} (${chars} chars)`);
    }

    if (oversizedFiles.length > 0) {
      logger.warn(`[stream-text] Oversized files in context: ${oversizedFiles.join(', ')}`);
    }

    if (totalChars > MAX_CONTEXT_CHARS) {
      logger.warn(`[stream-text] Context too large (${Math.round(totalChars / 1000)}k chars > ${Math.round(MAX_CONTEXT_CHARS / 1000)}k limit), truncating`);
      effectiveContextFiles = truncateContextFiles(contextFiles!, MAX_CONTEXT_CHARS);
      logger.info(`[stream-text] After truncation: ${Object.keys(effectiveContextFiles).length} file(s) kept`);
    }

    const codeContext = createFilesContext(effectiveContextFiles, true);

    systemPrompt = `${systemPrompt}

Below is the artifact containing the context loaded into context buffer for you to have knowledge of and might need changes to fulfill current user request.

CONTEXT BUFFER:
---
${codeContext}
---
`;

    if (summary) {
      systemPrompt = `${systemPrompt}

Below is the chat history till now

CHAT SUMMARY:
---
${summary}
---
`;

      if (props.messageSliceId) {
        processedMessages = processedMessages.slice(props.messageSliceId);
      } else {
        const lastMessage = processedMessages.pop();
        processedMessages = lastMessage ? [lastMessage] : [];
      }
    }
  }

  const effectiveLockedFilePaths = new Set<string>();
  if (files) {
    for (const [filePath, fileDetails] of Object.entries(files)) {
      if ((fileDetails as any)?.isLocked) effectiveLockedFilePaths.add(filePath);
    }
  }

  if (effectiveLockedFilePaths.size > 0) {
    const lockedFilesListString = Array.from(effectiveLockedFilePaths)
      .map((filePath) => `- ${filePath}`)
      .join("\n");

    systemPrompt = `${systemPrompt}

IMPORTANT: The following files are locked and MUST NOT be modified in any way. Do not suggest or make any changes to these files:
${lockedFilesListString}
---
`;
  }

  logger.info(`Sending llm call to Tachyon (single provider + single model)`);

  const timeoutSignal = createStreamTimeout(LLM_STREAM_TIMEOUT_MS);
  const abortSignal = clientAbortSignal
    ? AbortSignal.any([timeoutSignal, clientAbortSignal])
    : timeoutSignal;

  const streamParams = {
    model: getTachyonModel(),
    system: (chatMode === "build" || isPlanMode) ? systemPrompt : discussPrompt(),
    messages: convertToCoreMessages(processedMessages as any),
    ...(options || {}),
    abortSignal,
  } as Parameters<typeof _streamText>[0];

  return await _streamText(streamParams);
}

const LLM_STREAM_TIMEOUT_MS = 60_000;
const MAX_CONTEXT_CHARS = 400_000;
const MAX_SINGLE_FILE_CHARS = 100_000;

function estimateContextSize(contextFiles: FileMap): { totalChars: number; oversizedFiles: string[] } {
  let totalChars = 0;
  const oversizedFiles: string[] = [];
  for (const [path, file] of Object.entries(contextFiles)) {
    if (file && file.type === 'file' && !(file as any).isBinary && typeof (file as any).content === 'string') {
      const chars = (file as any).content.length;
      if (chars > MAX_SINGLE_FILE_CHARS) {
        oversizedFiles.push(`${path} (${Math.round(chars / 1000)}k chars)`);
      }
      totalChars += chars;
    }
  }
  return { totalChars, oversizedFiles };
}

function truncateContextFiles(contextFiles: FileMap, budget: number, priorityPaths?: Set<string>): FileMap {
  const result: FileMap = {};
  let remaining = budget;

  const entries = Object.entries(contextFiles).filter(
    ([, file]) => file && file.type === 'file' && !(file as any).isBinary,
  );

  const priority = priorityPaths && priorityPaths.size > 0
    ? entries.filter(([p]) => priorityPaths.has(p))
    : [];
  const rest = entries
    .filter(([p]) => !priorityPaths?.has(p))
    .sort((a, b) => {
      const aLen = ((a[1] as any).content || '').length;
      const bLen = ((b[1] as any).content || '').length;
      return aLen - bLen;
    });

  const ordered = [...priority, ...rest];

  for (const [path, file] of ordered) {
    if (remaining <= 0) break;
    const content: string = (file as any).content || '';
    if (content.length <= remaining) {
      result[path] = file;
      remaining -= content.length;
    } else if (remaining > 2000) {
      const truncated = content.slice(0, remaining - 500) + '\n\n[... file truncated: too large for context window ...]';
      result[path] = { ...file, content: truncated } as any;
      remaining = 0;
    }
  }
  return result;
}

function createStreamTimeout(ms: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    logger.warn(`LLM stream timed out after ${ms}ms`);
    controller.abort(new Error(`LLM stream timed out after ${ms}ms`));
  }, ms);

  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });

  return controller.signal;
}

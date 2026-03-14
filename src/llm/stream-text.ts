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

function sanitizeText(text: string): string {
  let sanitized = text.replace(/<div class=\\"__cortexThought__\\">.*?<\/div>/s, "");
  sanitized = sanitized.replace(/<think>.*?<\/think>/s, "");
  sanitized = sanitized.replace(/<cortexAction type="file" filePath="package-lock\.json">[\s\S]*?<\/cortexAction>/g, "");
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

  // Keeping these for compatibility with existing callers,
  // but Tachyon version does not use them:
  apiKeys?: Record<string, string>;
  providerSettings?: any;
  promptId?: string;
  env?: any;
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
  } = props;

  // Sanitize messages
  let processedMessages = messages.map((message: any) => {
    const newMessage = { ...message };

    if (message.role === "user" && typeof message.content === "string") {
      newMessage.content = sanitizeText(message.content);
    } else if (message.role === "assistant" && typeof message.content === "string") {
      newMessage.content = sanitizeText(message.content);
    }

    // Sanitize all text parts in parts array, if present
    if (Array.isArray(message.parts)) {
      newMessage.parts = message.parts.map((part: any) =>
        part.type === "text" ? { ...part, text: sanitizeText(part.text) } : part,
      );
    }

    return newMessage;
  });

  // Build system prompt
  let systemPrompt =
    PromptLibrary.getPropmtFromLibrary(promptId || "default", {
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

  // Build mode: inject context buffer + optional summary
  if (chatMode === "build" && contextFiles && contextOptimization) {
    const codeContext = createFilesContext(contextFiles, true);

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

      // If messageSliceId provided, slice messages so model focuses on latest
      if (props.messageSliceId) {
        processedMessages = processedMessages.slice(props.messageSliceId);
      } else {
        // fallback: keep only the last message
        const lastMessage = processedMessages.pop();
        processedMessages = lastMessage ? [lastMessage] : [];
      }
    }
  }

  // Locked files enforcement
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

  // NOTE: Token params are intentionally simple for Tachyon.
  // If you want a hard limit, set maxTokens here or pass via options.
  const streamParams = {
    model: getTachyonModel(),
    system: chatMode === "build" ? systemPrompt : discussPrompt(),
    messages: convertToCoreMessages(processedMessages as any),

    // Pass through any extra streaming options the caller provided
    ...(options || {}),
  } as Parameters<typeof _streamText>[0];

  return await _streamText(streamParams);
}
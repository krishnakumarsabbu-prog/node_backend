import type { Request, Response } from "express";
import { Readable } from "node:stream";
import { generateId } from "ai";

import { streamText } from "../llm/stream-text"; // your Tachyon-only streamText wrapper
import { stripIndents } from "../utils/stripIndent";
import { createScopedLogger } from "../utils/logger";

const logger = createScopedLogger("api.enhancer");

type EnhancerRequestBody = {
  message: string;

  // sent by UI but not needed in Tachyon-only backend
  model?: string;
  provider?: any;
  apiKeys?: Record<string, string>;
};

function setCORS(req: Request, res: Response) {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
}

function setStreamHeaders(res: Response) {
  // Your UI just reads bytes; it doesn't parse SSE events.
  // Keeping text/event-stream is fine (matches Remix), but it's still raw text.
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Cache-Control", "no-cache");
}

export async function enhancerHandler(req: Request, res: Response) {
  setCORS(req, res);

  const requestId = generateId();
  const startedAt = Date.now();

  if (req.method === "OPTIONS") {
    logger.info(`[${requestId}] OPTIONS preflight`);
    res.status(204).end();
    return;
  }

  logger.info(
    `[${requestId}] ${req.method} ${req.originalUrl || req.url} ip=${req.ip || "unknown"} ua="${
      req.headers["user-agent"] || ""
    }"`,
  );

  try {
    const body = req.body as EnhancerRequestBody;

    if (!body || typeof body !== "object") {
      res.status(400).json({ error: true, message: "Missing request body", requestId });
      return;
    }

    const { message } = body;

    if (!message || typeof message !== "string") {
      res.status(400).json({ error: true, message: "Invalid or missing `message`", requestId });
      return;
    }

    const prompt = stripIndents`
      You are a professional prompt engineer specializing in crafting precise, effective prompts.
      Your task is to enhance prompts by making them more specific, actionable, and effective.

      I want you to improve the user prompt that is wrapped in \`<original_prompt>\` tags.

      For valid prompts:
      - Make instructions explicit and unambiguous
      - Add relevant context and constraints
      - Remove redundant information
      - Maintain the core intent
      - Ensure the prompt is self-contained
      - Use professional language

      For invalid or unclear prompts:
      - Respond with clear, professional guidance
      - Keep responses concise and actionable
      - Maintain a helpful, constructive tone
      - Focus on what the user should provide
      - Use a standard template for consistency

      IMPORTANT: Your response must ONLY contain the enhanced prompt text.
      Do not include any explanations, metadata, or wrapper tags.

      <original_prompt>
        ${message}
      </original_prompt>
    `;

    logger.info(`[${requestId}] Calling streamText() for enhancer...`);

    const result = await streamText({
      messages: [{ role: "user", content: prompt }],
      chatMode: "discuss",
      options: {
        system:
          "Return ONLY the enhanced prompt text. No explanations, no metadata, no wrapper tags.",
        temperature: 0.2,
      },
    });

    // IMPORTANT: stream RAW TEXT, because your UI concatenates decoded bytes directly.
    const webTextStream = (result as any).textStream as ReadableStream<any> | undefined;

    if (!webTextStream) {
      logger.error(`[${requestId}] streamText() did not return textStream`);
      res.status(500).json({ error: true, message: "No text stream returned", requestId });
      return;
    }

    setStreamHeaders(res);

    const nodeStream = Readable.fromWeb(webTextStream as any);

    nodeStream.on("error", (err) => logger.error(`[${requestId}] nodeStream error: ${err?.message || err}`, err));
    res.on("close", () => logger.warn(`[${requestId}] client disconnected`));
    res.on("finish", () => logger.info(`[${requestId}] finished elapsedMs=${Date.now() - startedAt}`));

    nodeStream.pipe(res);
  } catch (error: any) {
    logger.error(`[${requestId}] Handler error: ${error?.message || error}`, error);

    if (!res.headersSent) {
      res.status(500).json({
        error: true,
        message: error?.message || "Internal server error",
        requestId,
      });
      return;
    }

    // If already streaming, just end.
    res.end();
  }
}
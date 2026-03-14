import type { Request, Response } from "express";
import { Readable } from "node:stream";
import { generateId, generateText } from "ai";

import { streamText } from "../llm/stream-text"; // Tachyon-only wrapper
import { createScopedLogger } from "../utils/logger";
import { getTachyonModel } from "../modules/llm/providers/tachyon";

const logger = createScopedLogger("api.llmcall");

type LLMCallRequestBody = {
  system: string;
  message: string;

  // legacy fields from UI, ignored (tachyon-only)
  model?: string;
  provider?: any;

  streamOutput?: boolean;
};

function setCORS(req: Request, res: Response) {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
}

function setTextStreamHeaders(res: Response) {
  res.status(200);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Cache-Control", "no-cache");
}

export async function llmCallHandler(req: Request, res: Response) {
  setCORS(req, res);

  const requestId = generateId();
  const startedAt = Date.now();

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  try {
    const body = req.body as LLMCallRequestBody;

    if (!body || typeof body !== "object") {
      res.status(400).json({ error: true, message: "Missing request body", requestId });
      return;
    }

    const { system, message, streamOutput } = body;

    if (!system || typeof system !== "string") {
      res.status(400).json({ error: true, message: "Invalid or missing `system`", requestId });
      return;
    }

    if (!message || typeof message !== "string") {
      res.status(400).json({ error: true, message: "Invalid or missing `message`", requestId });
      return;
    }

    logger.info(
      `[${requestId}] llmcall mode=${streamOutput ? "stream" : "json"} systemLen=${system.length} messageLen=${
        message.length
      }`,
    );

    // STREAM MODE: raw text stream (not used by your template selector, but kept for compatibility)
    if (streamOutput) {
      const result = await streamText({
        options: { system },
        messages: [{ role: "user", content: message }]
      });

      const webTextStream = (result as any).textStream as ReadableStream<any> | undefined;
      if (!webTextStream) {
        res.status(500).json({ error: true, message: "No text stream returned", requestId });
        return;
      }

      setTextStreamHeaders(res);

      const nodeStream = Readable.fromWeb(webTextStream as any);
      nodeStream.on("error", (err) =>
        logger.error(`[${requestId}] nodeStream error: ${err?.message || err}`, err),
      );
      res.on("close", () => logger.warn(`[${requestId}] client disconnected`));
      res.on("finish", () => logger.info(`[${requestId}] finished elapsedMs=${Date.now() - startedAt}`));

      nodeStream.pipe(res);
      return;
    }

    // JSON MODE: used by your template selector
    const result = await generateText({
      model: getTachyonModel(),
      system,
      messages: [{ role: "user", content: message }],
      toolChoice: "none",
      temperature: 0,
    });

    // Your UI expects `{ text: string }`
    res.status(200).json({
      text: result.text,
      // optional extras if you want them later:
      usage: result.usage,
      finishReason: result.finishReason,
    });
  } catch (error: any) {
    const msg = error?.message || "Internal server error";
    const isTokenError =
      typeof msg === "string" &&
      (msg.includes("max_tokens") || msg.includes("token") || msg.includes("exceeds") || msg.includes("maximum"));

    logger.error(`[${requestId}] error: ${msg}`, error);

    res.status(isTokenError ? 400 : 500).json({
      error: true,
      message: isTokenError ? `Token limit error: ${msg}. Try reducing request size.` : msg,
      requestId,
      provider: "tachyon",
      isRetryable: !isTokenError,
    });
  }
}
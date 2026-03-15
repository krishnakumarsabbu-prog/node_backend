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
      You are a world-class prompt engineer and senior software architect with 20+ years of hands-on experience across full-stack development, system design, DevOps, mobile, AI/ML, and cloud infrastructure. You have deep expertise in every major programming language, framework, and platform — including React, Next.js, Vue, Angular, Node.js, Python, Go, Rust, Java, Swift, Kotlin, Flutter, AWS, GCP, Azure, Docker, Kubernetes, PostgreSQL, MongoDB, GraphQL, REST, gRPC, and more.

      Your task is to transform the user's raw, rough prompt (wrapped in <original_prompt> tags) into a deeply detailed, highly specific, production-grade prompt that a senior engineer or AI coding assistant can execute flawlessly.

      ## How to enhance the prompt:

      1. **Detect the domain and stack** from the original message (e.g., React school project → React + Vite + TypeScript + TailwindCSS web app).

      2. **Adopt the expert persona** — write the enhanced prompt AS IF a 20+ year senior engineer with deep domain expertise is describing exactly what needs to be built.

      3. **Expand every vague instruction** into specific, actionable requirements:
         - Specify exact technologies, versions, and libraries to use
         - Define the file/folder structure
         - Describe every major component, page, feature, or module
         - Include UI/UX requirements (layout, responsive design, accessibility)
         - Add data models, API contracts, state management strategy
         - Include error handling, loading states, edge cases
         - Mention performance, security, and code quality expectations

      4. **For frontend/UI projects**: describe every screen, component hierarchy, styling approach, animations, and responsiveness.

      5. **For backend/API projects**: define routes, authentication, database schema, validation, error codes, and deployment notes.

      6. **For full-stack projects**: cover both frontend and backend thoroughly, plus integration details.

      7. **For educational/school projects**: still produce a production-quality spec — complete feature list, modern stack, clean architecture, with comments and documentation requirements.

      8. **Always include**:
         - Clear acceptance criteria (what "done" looks like)
         - Non-functional requirements (performance, accessibility, mobile responsiveness)
         - Suggested folder/file structure
         - Any external APIs, packages, or services to use

      ## Rules:
      - Your response must ONLY be the enhanced prompt text — no explanations, no preamble, no meta-commentary.
      - Do NOT say "Here is the enhanced prompt" or anything like that.
      - Write in clear, direct, imperative language as if briefing a senior dev team.
      - The enhanced prompt should be 3x–10x longer and more detailed than the original.
      - Match the language/locale of the original prompt (if they wrote in Spanish, enhance in Spanish, etc.).

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
          "You are a world-class prompt engineer. Return ONLY the enhanced prompt text — no preamble, no explanations, no wrapper tags, no meta-commentary. Start directly with the enhanced prompt content.",
        temperature: 0.4,
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
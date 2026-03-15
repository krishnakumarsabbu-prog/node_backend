import type { Request, Response } from "express";
import { detectTemplate, getTemplateScaffold } from "../llm/template-detector.js";
import { writeScaffoldToDisk, getSessionPath } from "../modules/ai_engine/session/scaffoldWriter.js";
import { buildIndexForSession, getSessionIndex } from "../modules/ai_engine/agent.js";
import { invalidateSession } from "../modules/ai_engine/session/sessionStore.js";
import { createScopedLogger } from "../utils/logger.js";

const logger = createScopedLogger("api.template");

function setCorsHeaders(req: Request, res: Response) {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
}

export async function templateHandler(req: Request, res: Response) {
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  try {
    const { userRequest, templateId } = req.body as { userRequest?: string; templateId?: string };

    if (templateId) {
      logger.info(`Returning scaffold for explicit templateId: ${templateId}`);
      const scaffold = getTemplateScaffold(templateId as any);
      res.json({ success: true, scaffold });
      return;
    }

    if (!userRequest || typeof userRequest !== "string") {
      res.status(400).json({ error: true, message: "userRequest is required" });
      return;
    }

    logger.info(`Detecting template for: "${userRequest.substring(0, 80)}"`);
    const detection = await detectTemplate(userRequest);
    const scaffold = getTemplateScaffold(detection.templateId);

    res.json({ success: true, detection, scaffold });
  } catch (error: any) {
    logger.error(`Template handler error: ${error?.message}`, error);
    res.status(500).json({ error: true, message: error?.message || "Internal server error" });
  }
}

export async function templateInitHandler(req: Request, res: Response) {
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  try {
    const { sessionId, templateId, files } = req.body as {
      sessionId?: string;
      templateId?: string;
      files?: Record<string, string>;
    };

    if (!sessionId || typeof sessionId !== "string") {
      res.status(400).json({ error: true, message: "sessionId is required" });
      return;
    }

    let scaffoldFiles: Record<string, string>;

    if (files && typeof files === "object" && Object.keys(files).length > 0) {
      scaffoldFiles = files;
      logger.info(`Using provided files (${Object.keys(files).length}) for session ${sessionId}`);
    } else if (templateId) {
      const scaffold = getTemplateScaffold(templateId as any);
      scaffoldFiles = scaffold.files;
      logger.info(`Using template ${templateId} for session ${sessionId}`);
    } else {
      res.status(400).json({ error: true, message: "Either templateId or files is required" });
      return;
    }

    logger.info(`Writing scaffold to disk for session ${sessionId}`);
    const diskPath = writeScaffoldToDisk(sessionId, scaffoldFiles);

    logger.info(`Indexing scaffold at ${diskPath} for session ${sessionId}`);
    const index = await buildIndexForSession(sessionId, diskPath);

    res.json({
      success: true,
      sessionId,
      diskPath,
      statistics: index.statistics,
    });
  } catch (error: any) {
    logger.error(`Template init handler error: ${error?.message}`, error);
    res.status(500).json({ error: true, message: error?.message || "Internal server error" });
  }
}

export function templateIndexStatusHandler(req: Request, res: Response) {
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const { sessionId } = req.query as { sessionId?: string };

  if (!sessionId) {
    res.status(400).json({ error: true, message: "sessionId query param is required" });
    return;
  }

  const index = getSessionIndex(sessionId);

  if (!index) {
    res.json({ ready: false, sessionId });
    return;
  }

  res.json({
    ready: true,
    sessionId,
    statistics: index.statistics,
    diskPath: getSessionPath(sessionId),
  });
}

export function templateSessionDeleteHandler(req: Request, res: Response) {
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const { sessionId } = req.body as { sessionId?: string };

  if (!sessionId) {
    res.status(400).json({ error: true, message: "sessionId is required" });
    return;
  }

  invalidateSession(sessionId);
  res.json({ success: true, sessionId });
}

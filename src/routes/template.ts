import type { Request, Response } from "express";
import { detectTemplate, getTemplateScaffold } from "../llm/template-detector";
import { createScopedLogger } from "../utils/logger";

const logger = createScopedLogger("api.template");

export async function templateHandler(req: Request, res: Response) {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

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

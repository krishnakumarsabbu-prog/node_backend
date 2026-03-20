import { generateText } from "ai";
import { getTachyonModel } from "../../modules/llm/providers/tachyon";
import { createScopedLogger } from "../../utils/logger";
import type { ProjectIR } from "./ir-types";
import { emptyIR } from "./ir-types";

const logger = createScopedLogger("ir-builder");

const IR_SYSTEM = `
You are a software architect. Parse a project plan or user request and extract a structured Intermediate Representation (IR) of the project.

Return ONLY valid JSON — no prose, no markdown fences.

Schema:
{
  "entities": [
    { "name": string, "fields": [{ "name": string, "type": string, "optional": boolean }] }
  ],
  "routes": [
    { "path": string, "component": string, "method": "GET"|"POST"|"PUT"|"DELETE"|"PATCH"|null, "auth": boolean }
  ],
  "components": [
    { "name": string, "type": "page"|"layout"|"ui"|"form"|"modal"|"provider", "props": [], "route": string|null }
  ],
  "services": [
    { "name": string, "methods": string[], "dependencies": string[] }
  ],
  "tests": [
    { "sourceFile": string, "testFile": string, "framework": string }
  ]
}

Rules:
- Only include items that are clearly mentioned or strongly implied by the plan
- routes.method is null for frontend page routes (not API endpoints)
- components.type: "page" for routed views, "ui" for reusable components, "layout" for wrappers
- services.dependencies: list of other services/entities this service uses
- tests: only populate if the plan mentions testing
- All arrays may be empty
- Do NOT invent items not present in the plan
`;

export async function buildIRFromPlan(planText: string): Promise<ProjectIR> {
  try {
    const resp = await generateText({
      model: getTachyonModel(),
      system: IR_SYSTEM,
      prompt: planText.slice(0, 4000),
    });

    const cleaned = resp.text.trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "");
    const parsed = JSON.parse(cleaned) as Omit<ProjectIR, "rawSchema">;

    const ir: ProjectIR = {
      entities: Array.isArray(parsed.entities) ? parsed.entities.map((e) => ({ ...e, source: "plan" as const })) : [],
      routes: Array.isArray(parsed.routes) ? parsed.routes.map((r) => ({ ...r, source: "plan" as const })) : [],
      components: Array.isArray(parsed.components) ? parsed.components.map((c) => ({ ...c, source: "plan" as const })) : [],
      services: Array.isArray(parsed.services) ? parsed.services.map((s) => ({ ...s, source: "plan" as const })) : [],
      tests: Array.isArray(parsed.tests) ? parsed.tests.map((t) => ({ ...t, source: "plan" as const })) : [],
      rawSchema: parsed as unknown as Record<string, unknown>,
    };

    logger.info(
      `[ir-builder] IR built: entities=${ir.entities.length} routes=${ir.routes.length} components=${ir.components.length} services=${ir.services.length}`,
    );

    return ir;
  } catch (err: any) {
    logger.warn(`[ir-builder] Failed to build IR (non-fatal): ${err?.message}`);
    return emptyIR();
  }
}

export function formatIRBlock(ir: ProjectIR): string {
  const lines: string[] = ["<ProjectIR>"];

  if (ir.entities.length > 0) {
    lines.push("Entities:");
    for (const e of ir.entities) {
      const fieldStr = e.fields.map((f) => `${f.name}: ${f.type}${f.optional ? "?" : ""}`).join(", ");
      lines.push(`  - ${e.name} { ${fieldStr} }`);
    }
  }

  if (ir.routes.length > 0) {
    lines.push("Routes:");
    for (const r of ir.routes) {
      const method = r.method ? `[${r.method}] ` : "";
      const auth = r.auth ? " (auth)" : "";
      lines.push(`  - ${method}${r.path} → ${r.component}${auth}`);
    }
  }

  if (ir.components.length > 0) {
    lines.push("Components:");
    for (const c of ir.components) {
      const route = c.route ? ` @ ${c.route}` : "";
      lines.push(`  - ${c.name} (${c.type})${route}`);
    }
  }

  if (ir.services.length > 0) {
    lines.push("Services:");
    for (const s of ir.services) {
      lines.push(`  - ${s.name}: ${s.methods.join(", ")}`);
    }
  }

  lines.push("</ProjectIR>");

  return lines.join("\n");
}

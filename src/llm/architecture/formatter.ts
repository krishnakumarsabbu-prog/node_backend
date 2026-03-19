import type { ProjectArchitecture } from "./detector";

export function formatArchitectureBlock(arch: ProjectArchitecture): string {
  const cap = arch.capabilities;
  const layers = arch.layers;

  const layerLines: string[] = [];
  if (layers.entry.length > 0) layerLines.push(`  Entry:      ${layers.entry.join(", ")}`);
  if (layers.routing.length > 0) layerLines.push(`  Routing:    ${layers.routing.join(", ")}`);
  if (layers.controller.length > 0) layerLines.push(`  Controller: ${layers.controller.join(", ")}`);
  if (layers.service.length > 0) layerLines.push(`  Service:    ${layers.service.join(", ")}`);
  if (layers.data.length > 0) layerLines.push(`  Data:       ${layers.data.join(", ")}`);
  if (layers.ui.length > 0) layerLines.push(`  UI:         ${layers.ui.join(", ")}`);
  if (layers.config.length > 0) layerLines.push(`  Config:     ${layers.config.join(", ")}`);

  const capLines = [
    `  Routing:          ${cap.routing ? "Yes" : "No"}`,
    `  Navigation (UI):  ${cap.navigation ? "Yes" : "No"}`,
    `  API:              ${cap.api ? "Yes" : "No"}`,
    `  Database:         ${cap.database ? "Yes" : "No"}`,
    `  State Management: ${cap.stateManagement ? "Yes" : "No"}`,
    `  Auth:             ${cap.auth ? "Yes" : "No"}`,
  ];

  const lines: string[] = [
    `<ProjectArchitecture>`,
    `Language:     ${arch.language}`,
    `Framework:    ${arch.framework}`,
    `Project Type: ${arch.projectType}`,
    ``,
    `Entry Points:`,
    ...(arch.entryPoints.length > 0 ? arch.entryPoints.map((e) => `  - ${e}`) : ["  (none detected)"]),
    ``,
    `Capabilities:`,
    ...capLines,
    ``,
    `Layers:`,
    ...(layerLines.length > 0 ? layerLines : ["  (none mapped)"]),
    `</ProjectArchitecture>`,
  ];

  return lines.join("\n");
}

export function formatArchitectureConstraintRule(arch: ProjectArchitecture): string {
  const { capabilities: cap, projectType, framework } = arch;
  const rules: string[] = [];

  if (!cap.routing) {
    rules.push("- routing = false → DO NOT create route definitions or router configuration");
  }
  if (!cap.navigation) {
    rules.push("- navigation = false → DO NOT add navigation links, nav bars, or sidebar navigation");
  }
  if (projectType === "backend" || projectType === "cli" || projectType === "library") {
    rules.push("- No UI layer exists → DO NOT generate React/HTML/CSS UI components");
  }
  if (projectType === "frontend") {
    rules.push("- Frontend only → DO NOT generate server-side controllers or API route handlers");
  }
  if (!cap.database) {
    rules.push("- No database detected → DO NOT add ORM models, migrations, or database queries unless the step explicitly requires adding a database");
  }
  if (!cap.stateManagement && framework !== "unknown") {
    rules.push(`- No state management library detected → use local React state (useState/useReducer) unless adding a state library is part of the request`);
  }

  if (rules.length === 0) return "";

  return [
    `ARCHITECTURE CONSTRAINTS (derived from ProjectArchitecture above — MUST be obeyed):`,
    ...rules,
    `All integration decisions MUST be derived from the ProjectArchitecture structure.`,
    `Only use layers that exist. Do not invent layers or patterns not present in this project.`,
  ].join("\n");
}

// llm/prompt-selection.ts (Node version)

import { ModelInfo } from "../types/model";



/**
 * Heuristic: treat smaller-context models (common for local/smaller LLMs) as "small".
 * Also treat very low output limits as small.
 */
export function isSmallModelForPrompting(model: ModelInfo): boolean {
  const maxContext = model.maxTokenAllowed ?? 0;
  const maxOutput = model.maxCompletionTokens ?? 0;

  // Small context OR very low output capacity
  if (maxContext > 0 && maxContext <= 20_000) return true;
  if (maxOutput > 0 && maxOutput <= 2048) return true;

  return false;
}

export function resolvePromptIdForModel(options: {
  promptId?: string;
  model: ModelInfo;
  chatMode: "discuss" | "build";
}): string {
  const { promptId, model, chatMode } = options;
  const requested = promptId || "default";

  // Only override for build mode when using default prompt
  if (chatMode === "build" && requested === "default" && isSmallModelForPrompting(model)) {
    return "small";
  }

  return requested;
}

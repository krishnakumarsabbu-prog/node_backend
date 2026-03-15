type ToolCallLike = {
  toolName: string;
  args?: unknown;
};

export type RecoveryReason = "repeated-tool-loop" | "no-progress" | "output-stagnation" | "stream-timeout" | "task-regression" | "context-exhaustion";

export type EscalationLevel = "nudge" | "redirect" | "finalize" | "restart";

export interface RecoverySignal {
  reason: RecoveryReason;
  escalation: EscalationLevel;
  message: string;
  detail: string;
  backoffMs: number;
  injectedPrompt?: string;
  suggestedAction?: "continue" | "decompose" | "summarize-and-retry" | "abort";
}

interface AgentRecoveryControllerOptions {
  repeatToolThreshold?: number;
  noProgressThreshold?: number;
  timeoutThreshold?: number;
  stagnationThreshold?: number;
  regressionThreshold?: number;
  contextExhaustionThreshold?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

const defaultOptions: Required<AgentRecoveryControllerOptions> = {
  repeatToolThreshold: 3,
  noProgressThreshold: 3,
  timeoutThreshold: 2,
  stagnationThreshold: 3,
  regressionThreshold: 2,
  contextExhaustionThreshold: 2,
  baseBackoffMs: 500,
  maxBackoffMs: 8_000,
};

function stableArgs(input: unknown, depth = 0, seen = new WeakSet()): string {
  if (depth > 6) return '"[deep]"';
  if (!input || typeof input !== "object") {
    const s = String(input ?? "");
    return s.length > 200 ? s.slice(0, 200) + "…" : s;
  }
  if (seen.has(input as object)) return '"[circular]"';
  seen.add(input as object);
  if (Array.isArray(input)) {
    const items = input.slice(0, 20).map((v) => stableArgs(v, depth + 1, seen));
    return `[${items.join(",")}]`;
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record).sort().slice(0, 20);
  return `{${keys.map((k) => `${k}:${stableArgs(record[k], depth + 1, seen)}`).join(",")}}`;
}

function buildToolSignature(toolCalls: ToolCallLike[]): string {
  if (toolCalls.length === 0) return "";
  return toolCalls.map((c) => `${c.toolName}:${stableArgs(c.args)}`).join("|");
}

function escalationForCount(count: number, threshold: number): EscalationLevel {
  if (count >= threshold + 3) return "restart";
  if (count >= threshold + 2) return "finalize";
  if (count >= threshold + 1) return "redirect";
  return "nudge";
}

const RECOVERY_PROMPTS: Record<RecoveryReason, (detail: string) => string> = {
  "repeated-tool-loop": (d) =>
    `You appear to be repeating the same tool call: ${d}. Break the loop by trying a completely different tool, a different argument, or a different strategy entirely. If the tool keeps failing, stop using it and summarize what you know so far.`,
  "no-progress": () =>
    `No meaningful progress has been made in the last several steps. Stop, take stock of what you have accomplished so far, identify the single most important next action, and execute it decisively. Avoid analysis paralysis.`,
  "output-stagnation": () =>
    `Your output has stalled or become repetitive. Either complete the current response with what you have, or explicitly state what is blocking you and propose an alternative approach.`,
  "stream-timeout": () =>
    `The stream timed out. Resume immediately and continue from where you left off. Be concise — prioritize completing the most important remaining actions.`,
  "task-regression": (d) =>
    `You appear to be undoing work already completed: ${d}. Preserve completed work and only add or modify what is strictly necessary for the current step.`,
  "context-exhaustion": () =>
    `The context is becoming very large. Summarize the key decisions and completed actions so far, then continue with only the most critical remaining task.`,
};

const DECOMPOSITION_PROMPT = (task: string) =>
  `The task "${task}" appears to be too complex to complete in one shot. Break it into 3-5 concrete sub-tasks, complete the first sub-task fully, then proceed to the next one in sequence.`;

export class AgentRecoveryController {
  private _options: Required<AgentRecoveryControllerOptions>;
  private _lastToolSignature = "";
  private _repeatedToolCount = 0;
  private _noProgressCount = 0;
  private _timeoutCount = 0;
  private _regressionCount = 0;
  private _contextExhaustionCount = 0;
  private _recoveryCount = 0;
  private _outputLengths: number[] = [];
  private _completedToolNames = new Set<string>();
  private _stepHistory: string[] = [];
  private _totalSteps = 0;

  constructor(options: AgentRecoveryControllerOptions = {}) {
    this._options = { ...defaultOptions, ...options };
  }

  reset(): void {
    this._lastToolSignature = "";
    this._repeatedToolCount = 0;
    this._noProgressCount = 0;
    this._timeoutCount = 0;
    this._regressionCount = 0;
    this._contextExhaustionCount = 0;
    this._recoveryCount = 0;
    this._outputLengths = [];
    this._completedToolNames.clear();
    this._stepHistory = [];
    this._totalSteps = 0;
  }

  private _nextBackoffMs(): number {
    this._recoveryCount++;
    return Math.min(this._options.maxBackoffMs, this._options.baseBackoffMs * 2 ** (this._recoveryCount - 1));
  }

  recordToolCompletion(toolName: string): void {
    this._completedToolNames.add(toolName);
  }

  recordStep(description: string): void {
    this._stepHistory.push(description);
    this._totalSteps++;
  }

  getCompletedTools(): string[] {
    return Array.from(this._completedToolNames);
  }

  getTotalSteps(): number {
    return this._totalSteps;
  }

  analyzeStep(
    toolCalls: ToolCallLike[],
    toolResultsCount: number,
    outputLength?: number,
    outputText?: string,
  ): RecoverySignal | undefined {
    const signature = buildToolSignature(toolCalls);

    if (signature) {
      this._repeatedToolCount = signature === this._lastToolSignature ? this._repeatedToolCount + 1 : 1;
      this._lastToolSignature = signature;
    } else {
      this._repeatedToolCount = 0;
      this._lastToolSignature = "";
    }

    if (toolCalls.length === 0 && toolResultsCount === 0) {
      this._noProgressCount++;
    } else {
      this._noProgressCount = 0;
    }

    if (outputLength !== undefined) {
      this._outputLengths.push(outputLength);
      if (this._outputLengths.length > 5) this._outputLengths.shift();
    }

    if (outputText && this._stepHistory.length > 0) {
      const revertPatterns = ["undo", "revert", "restore", "rollback", "going back", "step back"];
      const lowerOutput = outputText.toLowerCase();
      if (revertPatterns.some((p) => lowerOutput.includes(p))) {
        this._regressionCount++;
      } else {
        this._regressionCount = 0;
      }
    }

    if (this._repeatedToolCount >= this._options.repeatToolThreshold) {
      const backoffMs = this._nextBackoffMs();
      const esc = escalationForCount(this._repeatedToolCount, this._options.repeatToolThreshold);
      return {
        reason: "repeated-tool-loop",
        escalation: esc,
        message: "Repeated tool loop detected.",
        detail: `Tool sequence repeated: ${signature}`,
        backoffMs,
        injectedPrompt: RECOVERY_PROMPTS["repeated-tool-loop"](signature),
        suggestedAction: esc === "restart" ? "decompose" : "continue",
      };
    }

    if (this._noProgressCount >= this._options.noProgressThreshold) {
      const backoffMs = this._nextBackoffMs();
      const esc = escalationForCount(this._noProgressCount, this._options.noProgressThreshold);
      return {
        reason: "no-progress",
        escalation: esc,
        message: "No-progress streak detected.",
        detail: `${this._noProgressCount} consecutive empty steps`,
        backoffMs,
        injectedPrompt: RECOVERY_PROMPTS["no-progress"](""),
        suggestedAction: esc === "finalize" ? "summarize-and-retry" : "continue",
      };
    }

    if (this._outputLengths.length >= 3 && this._isOutputStagnant()) {
      const backoffMs = this._nextBackoffMs();
      return {
        reason: "output-stagnation",
        escalation: "nudge",
        message: "Output stagnation detected.",
        detail: `Lengths: ${this._outputLengths.join(", ")}`,
        backoffMs,
        injectedPrompt: RECOVERY_PROMPTS["output-stagnation"](""),
        suggestedAction: "continue",
      };
    }

    if (this._regressionCount >= this._options.regressionThreshold) {
      const backoffMs = this._nextBackoffMs();
      return {
        reason: "task-regression",
        escalation: "redirect",
        message: "Task regression detected — agent undoing completed work.",
        detail: `Regression count: ${this._regressionCount}`,
        backoffMs,
        injectedPrompt: RECOVERY_PROMPTS["task-regression"](`regression #${this._regressionCount}`),
        suggestedAction: "continue",
      };
    }

    return undefined;
  }

  registerTimeout(): RecoverySignal {
    this._timeoutCount++;
    const backoffMs = this._nextBackoffMs();
    const esc = escalationForCount(this._timeoutCount, this._options.timeoutThreshold);
    return {
      reason: "stream-timeout",
      escalation: esc,
      message: "Stream timeout detected.",
      detail: `Timeout #${this._timeoutCount}`,
      backoffMs,
      injectedPrompt: RECOVERY_PROMPTS["stream-timeout"](""),
      suggestedAction: esc === "restart" ? "summarize-and-retry" : "continue",
    };
  }

  registerContextExhaustion(): RecoverySignal {
    this._contextExhaustionCount++;
    const backoffMs = this._nextBackoffMs();
    const esc = escalationForCount(this._contextExhaustionCount, this._options.contextExhaustionThreshold);
    return {
      reason: "context-exhaustion",
      escalation: esc,
      message: "Context exhaustion detected.",
      detail: `Exhaustion count: ${this._contextExhaustionCount}`,
      backoffMs,
      injectedPrompt: RECOVERY_PROMPTS["context-exhaustion"](""),
      suggestedAction: "summarize-and-retry",
    };
  }

  buildDecompositionPrompt(task: string): string {
    return DECOMPOSITION_PROMPT(task);
  }

  private _isOutputStagnant(): boolean {
    if (this._outputLengths.length < 3) return false;
    const mean = this._outputLengths.reduce((a, b) => a + b, 0) / this._outputLengths.length;
    if (mean === 0) return true;
    const variance = this._outputLengths.reduce((a, b) => a + (b - mean) ** 2, 0) / this._outputLengths.length;
    const cv = Math.sqrt(variance) / mean;
    return cv < 0.1;
  }
}

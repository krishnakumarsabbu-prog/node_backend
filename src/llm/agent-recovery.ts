type ToolCallLike = {
  toolName: string;
  args?: unknown;
};

export type RecoveryReason = "repeated-tool-loop" | "no-progress" | "output-stagnation" | "stream-timeout";

export type EscalationLevel = "nudge" | "redirect" | "finalize";

export interface RecoverySignal {
  reason: RecoveryReason;
  escalation: EscalationLevel;
  message: string;
  detail: string;
  backoffMs: number;
  injectedPrompt?: string;
}

interface AgentRecoveryControllerOptions {
  repeatToolThreshold?: number;
  noProgressThreshold?: number;
  timeoutThreshold?: number;
  stagnationThreshold?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
}

const defaultOptions: Required<AgentRecoveryControllerOptions> = {
  repeatToolThreshold: 3,
  noProgressThreshold: 3,
  timeoutThreshold: 2,
  stagnationThreshold: 3,
  baseBackoffMs: 500,
  maxBackoffMs: 4_000,
};

function stableArgs(input: unknown): string {
  if (!input || typeof input !== "object") return String(input ?? "");
  if (Array.isArray(input)) return `[${input.map(stableArgs).join(",")}]`;
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${k}:${stableArgs(record[k])}`).join(",")}}`;
}

function buildToolSignature(toolCalls: ToolCallLike[]): string {
  if (toolCalls.length === 0) return "";
  return toolCalls.map((c) => `${c.toolName}:${stableArgs(c.args)}`).join("|");
}

function escalationForCount(count: number, threshold: number): EscalationLevel {
  if (count >= threshold + 2) return "finalize";
  if (count >= threshold + 1) return "redirect";
  return "nudge";
}

const RECOVERY_PROMPTS: Record<RecoveryReason, (detail: string) => string> = {
  "repeated-tool-loop": (d) =>
    `You appear to be repeating the same tool call: ${d}. Try a different tool or approach to make progress.`,
  "no-progress": () =>
    `No progress has been made in the last several steps. Summarize what you know so far and pick a different strategy to move forward.`,
  "output-stagnation": () =>
    `Your output appears to have stalled. Please continue generating the response or conclude with what you have.`,
  "stream-timeout": () =>
    `The stream timed out. Please resume and continue with the task. Be concise.`,
};

export class AgentRecoveryController {
  private _options: Required<AgentRecoveryControllerOptions>;
  private _lastToolSignature = "";
  private _repeatedToolCount = 0;
  private _noProgressCount = 0;
  private _timeoutCount = 0;
  private _recoveryCount = 0;
  private _outputLengths: number[] = [];

  constructor(options: AgentRecoveryControllerOptions = {}) {
    this._options = { ...defaultOptions, ...options };
  }

  reset(): void {
    this._lastToolSignature = "";
    this._repeatedToolCount = 0;
    this._noProgressCount = 0;
    this._timeoutCount = 0;
    this._recoveryCount = 0;
    this._outputLengths = [];
  }

  private _nextBackoffMs(): number {
    this._recoveryCount++;
    return Math.min(this._options.maxBackoffMs, this._options.baseBackoffMs * 2 ** (this._recoveryCount - 1));
  }

  analyzeStep(
    toolCalls: ToolCallLike[],
    toolResultsCount: number,
    outputLength?: number,
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
    };
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

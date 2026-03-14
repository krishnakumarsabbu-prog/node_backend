import { createScopedLogger } from "../utils/logger";

const logger = createScopedLogger("stream-recovery");

export type StreamHealthState = "healthy" | "degraded" | "stalled" | "dead";

export interface StreamGuardOptions {
  activityTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  maxRetries?: number;
  onDegraded?: () => void;
  onStalled?: () => void;
  onDead?: () => void;
}

export interface StreamGuardMetrics {
  state: StreamHealthState;
  retries: number;
  bytesReceived: number;
  chunksReceived: number;
  elapsedMs: number;
  lastActivityMs: number;
}

const DEFAULTS: Required<Omit<StreamGuardOptions, "onDegraded" | "onStalled" | "onDead">> = {
  activityTimeoutMs: 30_000,
  heartbeatIntervalMs: 5_000,
  maxRetries: 3,
};

export class StreamGuard {
  private _state: StreamHealthState = "healthy";
  private _lastActivity = Date.now();
  private _startedAt = Date.now();
  private _bytesReceived = 0;
  private _chunksReceived = 0;
  private _retries = 0;
  private _stopped = false;
  private _heartbeatTimer: NodeJS.Timeout | null = null;
  private _opts: Required<Omit<StreamGuardOptions, "onDegraded" | "onStalled" | "onDead">> & Pick<StreamGuardOptions, "onDegraded" | "onStalled" | "onDead">;

  constructor(opts: StreamGuardOptions = {}) {
    this._opts = { ...DEFAULTS, ...opts };
  }

  start(): void {
    if (this._stopped) return;
    this._startHeartbeat();
    logger.debug("StreamGuard started");
  }

  stop(): void {
    this._stopped = true;
    this._clearHeartbeat();
    if (this._state !== "dead") {
      this._transition("healthy");
    }
    logger.debug("StreamGuard stopped");
  }

  recordActivity(bytes = 0): void {
    this._lastActivity = Date.now();
    this._bytesReceived += bytes;
    this._chunksReceived++;

    if (this._state === "degraded" || this._state === "stalled") {
      logger.info("StreamGuard: activity resumed, transitioning back to healthy");
      this._transition("healthy");
    }
  }

  get canRetry(): boolean {
    return this._retries < this._opts.maxRetries && !this._stopped;
  }

  consumeRetry(): number {
    this._retries++;
    const backoff = Math.min(10_000, 500 * 2 ** (this._retries - 1));
    logger.info(`StreamGuard: retry ${this._retries}/${this._opts.maxRetries}, backoff=${backoff}ms`);
    return backoff;
  }

  get state(): StreamHealthState {
    return this._state;
  }

  metrics(): StreamGuardMetrics {
    return {
      state: this._state,
      retries: this._retries,
      bytesReceived: this._bytesReceived,
      chunksReceived: this._chunksReceived,
      elapsedMs: Date.now() - this._startedAt,
      lastActivityMs: Date.now() - this._lastActivity,
    };
  }

  private _startHeartbeat(): void {
    this._heartbeatTimer = setInterval(() => this._tick(), this._opts.heartbeatIntervalMs);
  }

  private _clearHeartbeat(): void {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  private _tick(): void {
    if (this._stopped) return;

    const silenceMs = Date.now() - this._lastActivity;
    const { activityTimeoutMs } = this._opts;
    const degradedThresholdMs = activityTimeoutMs * 0.5;

    if (silenceMs >= activityTimeoutMs) {
      if (this._state !== "dead") {
        if (this.canRetry) {
          this._transition("stalled");
          this._opts.onStalled?.();
        } else {
          this._transition("dead");
          this._clearHeartbeat();
          this._opts.onDead?.();
        }
      }
    } else if (silenceMs >= degradedThresholdMs) {
      if (this._state === "healthy") {
        this._transition("degraded");
        this._opts.onDegraded?.();
      }
    }
  }

  private _transition(next: StreamHealthState): void {
    if (this._state !== next) {
      logger.info(`StreamGuard: ${this._state} -> ${next}`);
      this._state = next;
    }
  }
}

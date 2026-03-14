import { createScopedLogger } from "../../utils/logger";

const logger = createScopedLogger("retry-utility");

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  exponentialBackoff: boolean;
  onRetry?: (attempt: number, error: Error) => void;
}

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  exponentialBackoff: true,
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError: Error;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt < opts.maxRetries) {
        const delay = opts.exponentialBackoff
          ? Math.min(opts.baseDelayMs * Math.pow(2, attempt), opts.maxDelayMs)
          : opts.baseDelayMs;

        logger.warn(
          `Retry attempt ${attempt + 1}/${opts.maxRetries} after ${delay}ms. Error: ${lastError.message}`
        );

        if (opts.onRetry) {
          opts.onRetry(attempt + 1, lastError);
        }

        await sleep(delay);
      }
    }
  }

  logger.error(`All retry attempts exhausted. Last error: ${lastError!.message}`);
  throw lastError!;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retryWithValidation<T>(
  fn: () => Promise<T>,
  validate: (result: T) => boolean,
  options: Partial<RetryOptions> = {}
): Promise<T> {
  return withRetry(
    async () => {
      const result = await fn();
      if (!validate(result)) {
        throw new Error("Validation failed");
      }
      return result;
    },
    options
  );
}

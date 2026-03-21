import { generateText } from "ai";
import { getTachyonModel } from "../../modules/llm/providers/tachyon";
import { withRetry } from "../utils/retry";
import { createScopedLogger } from "../../utils/logger";
import type { LLMResponse } from "../types/migrationTypes";

const logger = createScopedLogger("llm-client");

export interface LLMClientConfig {
  maxTokens: number;
  temperature: number;
  timeout: number;
}

const DEFAULT_CONFIG: LLMClientConfig = {
  maxTokens: 4096,
  temperature: 0.1,
  timeout: 60000,
};

export class LLMClient {
  private config: LLMClientConfig;

  constructor(config: Partial<LLMClientConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async generateWithRetry<T>(
    prompt: string,
    parser: (text: string) => T,
    options: {
      maxRetries?: number;
      systemPrompt?: string;
    } = {}
  ): Promise<LLMResponse<T>> {
    const maxRetries = options.maxRetries ?? 3;
    let retries = 0;

    try {
      const result = await withRetry(
        async () => {
          logger.info(`LLM generation attempt ${retries + 1}`);

          const messages: any[] = [];

          if (options.systemPrompt) {
            messages.push({
              role: "system",
              content: options.systemPrompt,
            });
          }

          messages.push({
            role: "user",
            content: prompt,
          });

          const abortController = new AbortController();
          const timeoutHandle = setTimeout(
            () => abortController.abort(new Error(`LLM request timed out after ${this.config.timeout}ms`)),
            this.config.timeout
          );

          let response: Awaited<ReturnType<typeof generateText>>;
          try {
            response = await generateText({
              model: getTachyonModel(),
              messages,
              maxTokens: this.config.maxTokens,
              temperature: this.config.temperature,
              abortSignal: abortController.signal,
            });
          } finally {
            clearTimeout(timeoutHandle);
          }

          const parsedData = parser(response.text);

          return parsedData;
        },
        {
          maxRetries,
          baseDelayMs: 2000,
          exponentialBackoff: true,
          onRetry: (attempt) => {
            retries = attempt;
          },
        }
      );

      return {
        success: true,
        data: result,
        retries,
      };
    } catch (error) {
      logger.error(`LLM generation failed after ${retries} retries: ${(error as Error).message}`);
      return {
        success: false,
        error: (error as Error).message,
        retries,
      };
    }
  }

  async generateJSON<T>(
    prompt: string,
    validator: (data: unknown) => T,
    options: {
      maxRetries?: number;
      systemPrompt?: string;
    } = {}
  ): Promise<LLMResponse<T>> {
    return this.generateWithRetry(
      prompt,
      (text) => {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          throw new Error("No JSON found in response");
        }

        const parsed = JSON.parse(jsonMatch[0]);
        return validator(parsed);
      },
      options
    );
  }

  async generateText(
    prompt: string,
    options: {
      maxRetries?: number;
      systemPrompt?: string;
    } = {}
  ): Promise<LLMResponse<string>> {
    return this.generateWithRetry(
      prompt,
      (text) => text.trim(),
      options
    );
  }
}

import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV1 } from 'ai';

/**
 * Minimal Tachyon client.
 *
 * - Single provider
 * - Single model
 * - No BaseProvider
 * - No dynamic models
 * - No env indirection
 * - No API key requirement (unless your Tachyon server enforces it)
 *
 * Change these two constants if needed.
 */
const TACHYON_BASE_URL = 'http://127.0.0.1:8000/v1';
const TACHYON_MODEL = 'tachyon-model';

/**
 * Returns a LanguageModelV1 compatible instance for Vercel AI SDK.
 */
export function getTachyonModel(): LanguageModelV1 {
  const openai = createOpenAI({
    baseURL: TACHYON_BASE_URL,
    apiKey: 'no-key-needed',
  });

  return openai(TACHYON_MODEL);
}

// Model settings. Prices are dollars per million tokens (first-party API, cached 2026-10-06).
//
// The primary model is NUXT_AI_MODEL (default claude-opus-5-5). When the API key cannot use it
// (429/403/404), calls fall back to NUXT_AI_FALLBACK_MODEL (default claude-haiku-4-5) and the
// primary is skipped for 15 minutes. On 2026-11-01 the production key could only call
// claude-haiku-4-5; every other model returned 429 with no detail.
export const MODEL = 'claude-opus-5-5'
export const FALLBACK_MODEL = 'claude-haiku-4-5'

export interface Price {
  input: number
  output: number
  /** A cache read (0.05x input on Opus 5.5, 0.1x on the others). */
  cacheRead: number
  /** A cache write with the default 5 minute lifetime (1.25x input). */
  cacheWrite5m: number
  /** A cache write with the 1 hour lifetime (2x input). */
  cacheWrite1h: number
  /** A second rate card for prompts over `over` tokens (Haiku 5.5 bills prompts over 100K tokens at 5x). */
  longPrompt?: { over: number } & Omit<Price, 'longPrompt'>
}

export const PRICES: Record<string, Price> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  'claude-haiku-5-5': {
    input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2,
    longPrompt: { over: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite5m: 0.625, cacheWrite1h: 1 },
  },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
}

export interface ModelProfile {
  /** Accepts output_config.effort. */
  effort: boolean
  /** Accepts the server-side refusal fallback beta. */
  fallbacks: boolean
}

export const PROFILES: Record<string, ModelProfile> = {
  'claude-opus-5-5': { effort: true, fallbacks: true },
  'claude-sonnet-5-5': { effort: true, fallbacks: true },
  'claude-haiku-5-5': { effort: true, fallbacks: false },
  'claude-haiku-4-5': { effort: false, fallbacks: false },
}

export function profileOf(model: string): ModelProfile {
  const key = Object.keys(PROFILES).find(k => model.startsWith(k))
  return key ? PROFILES[key]! : { effort: false, fallbacks: false }
}

export function priceOf(model: string): Price {
  const key = Object.keys(PRICES).find(k => model.startsWith(k))
  return key ? PRICES[key]! : PRICES[MODEL]!
}

/** The token counts a Messages API response reports in `usage`. input_tokens is only the part read neither from nor into the cache. */
export interface UsageCounts {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null
}

/**
 * Dollars for one response: uncached input, cache reads, cache writes (5 minute or 1 hour, from
 * usage.cache_creation; all of cache_creation_input_tokens counts as 5 minute when it is absent),
 * and output, each at the model's rate. The prompt size that picks a long-prompt rate card is all
 * three input counts together.
 */
export function usageCost(model: string, usage: UsageCounts): number {
  const base = priceOf(model)
  const input = usage.input_tokens ?? 0
  const read = usage.cache_read_input_tokens ?? 0
  const written = usage.cache_creation_input_tokens ?? 0
  const written1h = Math.min(written, usage.cache_creation?.ephemeral_1h_input_tokens ?? 0)
  const price = base.longPrompt && input + read + written > base.longPrompt.over ? base.longPrompt : base
  return (input * price.input
    + (usage.output_tokens ?? 0) * price.output
    + read * price.cacheRead
    + (written - written1h) * price.cacheWrite5m
    + written1h * price.cacheWrite1h) / 1_000_000
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

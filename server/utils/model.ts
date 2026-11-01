// Model settings. Prices are dollars per million tokens (first-party API, cached 2026-10-06).
//
// The primary model is NUXT_AI_MODEL (default claude-opus-5-5). When the API key cannot use it
// (429/403/404), calls fall back to NUXT_AI_FALLBACK_MODEL (default claude-haiku-4-5) and the
// primary is skipped for 15 minutes. On 2026-11-01 the production key could only call
// claude-haiku-4-5; every other model returned 429 with no detail.
export const MODEL = 'claude-opus-5-5'
export const FALLBACK_MODEL = 'claude-haiku-4-5'

export const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
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

export function priceOf(model: string) {
  const key = Object.keys(PRICES).find(k => model.startsWith(k))
  return key ? PRICES[key]! : PRICES[MODEL]!
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

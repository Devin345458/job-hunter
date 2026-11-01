import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { z } from 'zod'
import { and, gte, sql } from 'drizzle-orm'
import { aiCalls } from '../db/schema'
import { FALLBACK_MODEL, MODEL, priceOf, profileOf, type Effort } from './model'
import type { TailoredResume } from '#shared/types/pipeline'

let _client: Anthropic | null = null

export function useAI() {
  if (_client) return _client
  const config = useRuntimeConfig()
  _client = new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 3 })
  return _client
}

export class AiBudgetExceeded extends Error {
  constructor(spent: number, budget: number) {
    super(`Daily AI budget reached: $${spent.toFixed(2)} of $${budget.toFixed(2)} spent today`)
  }
}

export class AiRefusal extends Error {}

export class AiOutputTruncated extends Error {}

/** Dollars spent on Claude calls since local midnight. */
export function aiSpentToday(): number {
  const db = useDb()
  const row = db
    .select({ total: sql<number>`coalesce(sum(${aiCalls.costUsd}), 0)` })
    .from(aiCalls)
    .where(and(gte(aiCalls.createdAt, sql`datetime('now', 'localtime', 'start of day', 'utc')`)))
    .get()
  return row?.total ?? 0
}

export function aiBudget(): number {
  const config = useRuntimeConfig()
  return Number(config.dailyAiBudgetUsd) || 10
}

/** Throws AiBudgetExceeded when today's spend has reached the daily budget. */
export function assertAiBudget() {
  const spent = aiSpentToday()
  const budget = aiBudget()
  if (spent >= budget) throw new AiBudgetExceeded(spent, budget)
}

function costOf(model: string, usage: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }) {
  const price = priceOf(model)
  // Cache writes (5 minute TTL) bill at 1.25x the input price.
  return ((usage.input_tokens ?? 0) * price.input
    + (usage.output_tokens ?? 0) * price.output
    + (usage.cache_read_input_tokens ?? 0) * price.cacheRead
    + (usage.cache_creation_input_tokens ?? 0) * price.input * 1.25) / 1_000_000
}

function logCall(purpose: string, model: string, usage: any, ref?: { type: string; id: number }, error?: string) {
  try {
    useDb().insert(aiCalls).values({
      purpose,
      model,
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
      costUsd: usage ? costOf(model, usage) : 0,
      refType: ref?.type ?? null,
      refId: ref?.id ?? null,
      error: error ?? null,
    }).run()
  }
  catch (e) {
    console.error('[ai] failed to log call', e)
  }
}

export interface AiCallOptions {
  /** Short label stored with the usage row, e.g. "match", "tailor", "form_answers". */
  purpose: string
  system?: string
  prompt: string | Anthropic.Beta.BetaContentBlockParam[]
  effort?: Effort
  maxTokens?: number
  ref?: { type: string; id: number }
}

// ── Model selection with fallback ──

let primaryUnavailableUntil = 0

export function primaryModel(): string {
  return useRuntimeConfig().aiModel || MODEL
}

export function fallbackModel(): string {
  return useRuntimeConfig().aiFallbackModel || FALLBACK_MODEL
}

/** The model the next call will try first. */
export function activeModel(): string {
  return Date.now() < primaryUnavailableUntil ? fallbackModel() : primaryModel()
}

function isAccessError(e: any) {
  return e instanceof Anthropic.RateLimitError
    || e instanceof Anthropic.PermissionDeniedError
    || e instanceof Anthropic.NotFoundError
}

function buildParams(model: string, opts: AiCallOptions, format?: unknown) {
  const profile = profileOf(model)
  const outputConfig: Record<string, unknown> = {}
  if (profile.effort) outputConfig.effort = opts.effort ?? 'medium'
  if (format) outputConfig.format = format
  return {
    model,
    max_tokens: opts.maxTokens ?? 16000,
    ...(profile.fallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
    ...(opts.system ? { system: opts.system } : {}),
    messages: [{ role: 'user', content: opts.prompt }],
    ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
  } as any
}

/**
 * Runs one request against the primary model, and against the fallback model when the
 * key cannot use the primary. Every attempt is logged to ai_calls with its cost.
 */
async function withModel<T extends { usage?: any; model?: string; stop_reason?: string | null }>(
  opts: AiCallOptions,
  send: (model: string, requestOptions: { maxRetries: number }) => Promise<T>,
  preferredModel?: string,
): Promise<T> {
  assertAiBudget()
  const first = preferredModel && !(preferredModel === primaryModel() && Date.now() < primaryUnavailableUntil) ? preferredModel : activeModel()
  const models = [...new Set([first, fallbackModel()])]
  let lastError: any
  for (const model of models) {
    try {
      // One retry on the primary: an access 429 does not clear with backoff, so fail over fast.
      const response = await send(model, { maxRetries: model === fallbackModel() ? 3 : 1 })
      if (response.stop_reason === 'refusal') {
        logCall(opts.purpose, response.model || model, response.usage, opts.ref, 'refusal')
        throw new AiRefusal(`Claude declined the ${opts.purpose} request`)
      }
      if (response.stop_reason === 'max_tokens') {
        logCall(opts.purpose, response.model || model, response.usage, opts.ref, 'max_tokens')
        throw new AiOutputTruncated(`Claude ran out of output tokens on ${opts.purpose}`)
      }
      logCall(opts.purpose, response.model || model, response.usage, opts.ref)
      return response
    }
    catch (e: any) {
      lastError = e
      if (e instanceof AiRefusal || e instanceof AiOutputTruncated) throw e // already logged with usage
      if (!isAccessError(e) || model === fallbackModel()) {
        logCall(opts.purpose, model, null, opts.ref, e?.message || String(e))
        throw e
      }
      // The key cannot use this model right now. Skip it for 15 minutes and try the fallback.
      logCall(opts.purpose, model, null, opts.ref, `unavailable: ${e?.status} ${e?.message || ''}`.slice(0, 500))
      if (model === primaryModel()) primaryUnavailableUntil = Date.now() + 15 * 60 * 1000
      console.warn(`[ai] ${model} unavailable (${e?.status}), falling back to ${fallbackModel()}`)
    }
  }
  throw lastError
}

/**
 * One Claude call that returns an object validated against a zod schema, using structured
 * outputs (forced tool choice returns a 400 on the 5.x models). Enforces the daily budget.
 */
export async function aiStructured<S extends z.ZodType>(schema: S, opts: AiCallOptions): Promise<z.infer<S>> {
  const ai = useAI()
  const response = await withModel(opts, (model, ro) => ai.beta.messages.parse(buildParams(model, opts, betaZodOutputFormat(schema)), ro) as any)
  const parsed = (response as any).parsed_output
  if (parsed == null) throw new Error(`Claude returned no parseable output for ${opts.purpose}`)
  return parsed as z.infer<S>
}

export interface AiToolTurnOptions {
  /** Short label stored with the usage row. */
  purpose: string
  system: string
  messages: Anthropic.Beta.BetaMessageParam[]
  tools: Anthropic.Beta.BetaTool[]
  maxTokens?: number
  effort?: Effort
  ref?: { type: string; id: number }
  /** Model to try first instead of NUXT_AI_MODEL. The fallback model still applies. */
  model?: string
}

/**
 * One turn of a tool-use conversation (the demo builder's agent loop). Same budget check,
 * model fallback and ai_calls logging as aiStructured/aiText; the caller runs the tools.
 * The last block of the last message is marked for prompt caching so each turn reuses
 * the previous turn's prefix.
 */
export async function aiToolTurn(opts: AiToolTurnOptions): Promise<Anthropic.Beta.BetaMessage> {
  const ai = useAI()
  const callOpts: AiCallOptions = { purpose: opts.purpose, prompt: '', ref: opts.ref, effort: opts.effort, maxTokens: opts.maxTokens }
  const messages = opts.messages.map((m, i) => {
    const blocks = m.content
    if (i !== opts.messages.length - 1 || !Array.isArray(blocks)) return m
    const content = blocks.map((b, j) => (j === blocks.length - 1 ? { ...b, cache_control: { type: 'ephemeral' } } : b))
    return { ...m, content } as Anthropic.Beta.BetaMessageParam
  })
  return withModel(callOpts, (model, ro) => {
    const profile = profileOf(model)
    const params: any = {
      model,
      max_tokens: opts.maxTokens ?? 16000,
      system: [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }],
      tools: opts.tools,
      tool_choice: { type: 'auto' },
      messages,
      ...(profile.effort ? { output_config: { effort: opts.effort ?? 'medium' } } : {}),
      ...(profile.fallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
    }
    return ai.beta.messages.create(params, ro) as Promise<Anthropic.Beta.BetaMessage>
  }, opts.model)
}

/** One Claude call that returns plain text (cover letters and similar prose). */
export async function aiText(opts: AiCallOptions): Promise<string> {
  const ai = useAI()
  const response = await withModel(opts, (model, ro) => ai.beta.messages.create(buildParams(model, opts), ro) as Promise<Anthropic.Beta.BetaMessage>)
  return response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim()
}

// ── Existing features, moved onto aiStructured ──
// Capability agents replace these with richer versions; the signatures stay so the
// original pages keep working in the meantime.

export interface MatchResult {
  score: number
  reasoning: string
  missingSkills: string[]
  keywordOverlap: string[]
  recommendation: 'strong_match' | 'good_match' | 'partial_match' | 'weak_match'
}

const MatchResultSchema = z.object({
  score: z.number().describe('Match score from 0 to 100'),
  reasoning: z.string().describe('Two or three sentences explaining the score'),
  missingSkills: z.array(z.string()),
  keywordOverlap: z.array(z.string()),
  recommendation: z.enum(['strong_match', 'good_match', 'partial_match', 'weak_match']),
})

export function formatKnowledge(knowledgeBase: Record<string, string>) {
  return Object.entries(knowledgeBase).map(([k, v]) => `**${k}:** ${v}`).join('\n')
}

export async function scoreJobMatch(jobDescription: string, knowledgeBase: Record<string, string>): Promise<MatchResult> {
  return aiStructured(MatchResultSchema, {
    purpose: 'match',
    effort: 'low',
    maxTokens: 4000,
    prompt: `You are a job matching assistant. Score how well this candidate matches the job description.

## Candidate Profile
${formatKnowledge(knowledgeBase)}

## Job Description
${jobDescription}

Focus on role level match, tech stack overlap, and experience relevance. Be realistic and do not inflate scores.`,
  })
}

const TailoredResumeSchema = z.object({
  summary: z.string(),
  experience: z.array(z.object({
    company: z.string(),
    title: z.string(),
    period: z.string(),
    bullets: z.array(z.string()),
  })),
  skills: z.record(z.string(), z.array(z.string())),
  education: z.array(z.object({ institution: z.string(), degree: z.string(), year: z.string() })),
  tailoringNotes: z.string(),
  generatedQuestions: z.array(z.object({
    question: z.string(),
    context: z.string(),
    category: z.enum(['technical', 'behavioral', 'preference']),
  })),
})

export async function tailorResume(jobDescription: string, knowledgeBase: Record<string, string>): Promise<TailoredResume> {
  return aiStructured(TailoredResumeSchema, {
    purpose: 'tailor',
    effort: 'high',
    prompt: `You are a resume tailoring expert. Restructure and reframe the candidate's experience for this specific job.

## RULES
- NEVER fabricate experience. Only reframe and reorder existing experience.
- Prioritize relevant accomplishments. Match JD keywords naturally.
- Adjust the professional summary to target this role.
- Reorder experience bullets to highlight most relevant first.
- Add relevant keywords from the JD only where they genuinely apply.

## Candidate Knowledge Base
${formatKnowledge(knowledgeBase)}

## Target Job Description
${jobDescription}`,
  })
}

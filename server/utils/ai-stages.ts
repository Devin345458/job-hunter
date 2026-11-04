import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import { aiCalls, decisions } from '../db/schema'
import type { AiStageCost, AiStageCosts, AiStageKey } from '#shared/types/pipeline'

// Where the AI budget went, by stage of the decide-first flow: API key dollars plus the Agent SDK's
// estimate for calls on Devin's subscription (each call has one or the other: cost_usd on the key,
// est_cost_usd on the subscription), so the table adds up to the subscription bar above it. Each
// figure says how many of its calls ran on the subscription, so Settings marks those columns
// "est.". Every Claude call is logged in
// ai_calls with a purpose; each purpose belongs to one stage. Spending before Devin decides runs
// for every job; spending after Apply runs only for the applications he chose. Settings > Claude usage
// shows today and the last 7 days. A purpose this map does not know counts under Other.

interface StageDef {
  key: AiStageKey
  label: string
  phase: AiStageCost['phase']
  purposes: string[]
}

export const AI_STAGES: StageDef[] = [
  { key: 'read', label: 'Read postings', phase: 'before', purposes: ['enrich'] },
  { key: 'score', label: 'Score and gap plan', phase: 'before', purposes: ['match_gaps', 'match', 'gap_candidates', 'gap_decisions'] },
  { key: 'form', label: 'Read forms and questions', phase: 'before', purposes: ['form_option_map', 'question_match'] },
  { key: 'prepare', label: 'Prepare after Apply', phase: 'after', purposes: ['tailor', 'tailor_verify', 'cover_letter', 'cover_letter_verify', 'form_answers', 'form_answers_verify', 'form_answers_condense'] },
  { key: 'other', label: 'Other (chat, GitHub, learning, demos)', phase: 'other', purposes: [] },
]

export function stageOfPurpose(purpose: string): AiStageKey {
  return AI_STAGES.find(s => s.purposes.includes(purpose))?.key ?? 'other'
}

function totalsSince(since: ReturnType<typeof sql>) {
  return useDb().select({
    purpose: aiCalls.purpose,
    cost: sql<number>`coalesce(sum(${aiCalls.costUsd} + ${aiCalls.estCostUsd}), 0)`,
    calls: sql<number>`count(*)`,
    agentCalls: sql<number>`coalesce(sum(case when ${aiCalls.backend} = 'agent' then 1 else 0 end), 0)`,
  }).from(aiCalls).where(gte(aiCalls.createdAt, since)).groupBy(aiCalls.purpose).all()
}

/** Calls on Devin's subscription since `since`, with the Agent SDK's estimate of their API price. */
function subscriptionSince(since: ReturnType<typeof sql>) {
  const row = useDb().select({
    est: sql<number>`coalesce(sum(${aiCalls.estCostUsd}), 0)`,
    calls: sql<number>`count(*)`,
  }).from(aiCalls).where(and(gte(aiCalls.createdAt, since), eq(aiCalls.backend, 'agent'))).get()
  return { estUsd: round(row?.est ?? 0), calls: row?.calls ?? 0 }
}

const round = (n: number) => Math.round(n * 10000) / 10000

/** Today (local midnight, as aiSpentToday counts it) and the last 7 days, per stage. */
export function aiStageCosts(): AiStageCosts {
  const today = totalsSince(sql`datetime('now', 'localtime', 'start of day', 'utc')`)
  const week = totalsSince(sql`datetime('now', '-7 days')`)
  const sum = (rows: typeof today, key: AiStageKey) => rows
    .filter(r => stageOfPurpose(r.purpose) === key)
    .reduce((acc, r) => ({ costUsd: acc.costUsd + (r.cost ?? 0), calls: acc.calls + (r.calls ?? 0), subscriptionCalls: acc.subscriptionCalls + (r.agentCalls ?? 0) }), { costUsd: 0, calls: 0, subscriptionCalls: 0 })
  const stages = AI_STAGES.map((s) => {
    const t = sum(today, s.key)
    const w = sum(week, s.key)
    return {
      key: s.key,
      label: s.label,
      phase: s.phase,
      purposes: s.key === 'other' ? [...new Set(week.map(r => r.purpose).filter(p => stageOfPurpose(p) === 'other'))].sort() : s.purposes,
      today: { costUsd: round(t.costUsd), calls: t.calls, subscriptionCalls: t.subscriptionCalls },
      week: { costUsd: round(w.costUsd), calls: w.calls, subscriptionCalls: w.subscriptionCalls },
    }
  })
  const db = useDb()
  const applied = [...new Set(db.select({ id: decisions.applicationId }).from(decisions)
    .where(and(eq(decisions.decision, 'apply'), gte(decisions.createdAt, sql`datetime('now', '-7 days')`))).all().map(r => r.id))]
  const prepare = AI_STAGES.find(s => s.key === 'prepare')!.purposes
  const appliedPrepareUsd = applied.length
    ? db.select({ total: sql<number>`coalesce(sum(${aiCalls.costUsd} + ${aiCalls.estCostUsd}), 0)` }).from(aiCalls)
      .where(and(eq(aiCalls.refType, 'application'), inArray(aiCalls.refId, applied), inArray(aiCalls.purpose, prepare))).get()?.total ?? 0
    : 0
  const subscription = {
    today: subscriptionSince(sql`datetime('now', 'localtime', 'start of day', 'utc')`),
    week: subscriptionSince(sql`datetime('now', '-7 days')`),
  }
  return { stages, appliedThisWeek: applied.length, appliedPrepareUsd: round(appliedPrepareUsd), subscription }
}

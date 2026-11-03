import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import { aiCalls, decisions } from '../db/schema'
import type { AiStageCost, AiStageCosts, AiStageKey } from '#shared/types/pipeline'

// Where the AI budget went, by stage of the decide-first flow. Every Claude call is logged in
// ai_calls with a purpose; each purpose belongs to one stage. Spending before Devin decides runs
// for every job; spending after Apply runs only for the applications he chose. Settings > Pipeline
// shows today and the last 7 days. A purpose this map does not know counts under Other.

interface StageDef {
  key: AiStageKey
  label: string
  phase: AiStageCost['phase']
  purposes: string[]
}

export const AI_STAGES: StageDef[] = [
  { key: 'read', label: 'Read postings', phase: 'before', purposes: ['enrich'] },
  { key: 'score', label: 'Score and gap plan', phase: 'before', purposes: ['match', 'gap_candidates', 'gap_decisions'] },
  { key: 'form', label: 'Read forms and questions', phase: 'before', purposes: ['form_option_map', 'question_match'] },
  { key: 'prepare', label: 'Prepare after Apply', phase: 'after', purposes: ['tailor', 'tailor_verify', 'cover_letter', 'cover_letter_verify', 'form_answers', 'form_answers_verify'] },
  { key: 'other', label: 'Other (chat, GitHub, learning, demos)', phase: 'other', purposes: [] },
]

export function stageOfPurpose(purpose: string): AiStageKey {
  return AI_STAGES.find(s => s.purposes.includes(purpose))?.key ?? 'other'
}

function totalsSince(since: ReturnType<typeof sql>) {
  return useDb().select({
    purpose: aiCalls.purpose,
    cost: sql<number>`coalesce(sum(${aiCalls.costUsd}), 0)`,
    calls: sql<number>`count(*)`,
  }).from(aiCalls).where(gte(aiCalls.createdAt, since)).groupBy(aiCalls.purpose).all()
}

const round = (n: number) => Math.round(n * 10000) / 10000

/** Today (local midnight, as aiSpentToday counts it) and the last 7 days, per stage. */
export function aiStageCosts(): AiStageCosts {
  const today = totalsSince(sql`datetime('now', 'localtime', 'start of day', 'utc')`)
  const week = totalsSince(sql`datetime('now', '-7 days')`)
  const sum = (rows: typeof today, key: AiStageKey) => rows
    .filter(r => stageOfPurpose(r.purpose) === key)
    .reduce((acc, r) => ({ costUsd: acc.costUsd + (r.cost ?? 0), calls: acc.calls + (r.calls ?? 0) }), { costUsd: 0, calls: 0 })
  const stages = AI_STAGES.map((s) => {
    const t = sum(today, s.key)
    const w = sum(week, s.key)
    return {
      key: s.key,
      label: s.label,
      phase: s.phase,
      purposes: s.key === 'other' ? [...new Set(week.map(r => r.purpose).filter(p => stageOfPurpose(p) === 'other'))].sort() : s.purposes,
      today: { costUsd: round(t.costUsd), calls: t.calls },
      week: { costUsd: round(w.costUsd), calls: w.calls },
    }
  })
  const db = useDb()
  const applied = [...new Set(db.select({ id: decisions.applicationId }).from(decisions)
    .where(and(eq(decisions.decision, 'apply'), gte(decisions.createdAt, sql`datetime('now', '-7 days')`))).all().map(r => r.id))]
  const prepare = AI_STAGES.find(s => s.key === 'prepare')!.purposes
  const appliedPrepareUsd = applied.length
    ? db.select({ total: sql<number>`coalesce(sum(${aiCalls.costUsd}), 0)` }).from(aiCalls)
      .where(and(eq(aiCalls.refType, 'application'), inArray(aiCalls.refId, applied), inArray(aiCalls.purpose, prepare))).get()?.total ?? 0
    : 0
  return { stages, appliedThisWeek: applied.length, appliedPrepareUsd: round(appliedPrepareUsd) }
}

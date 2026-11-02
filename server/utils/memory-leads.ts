import { and, desc, eq, isNotNull } from 'drizzle-orm'
import { pipelineRuns, questions } from '../db/schema'
import type { MemoryLeadsResponse, MemoryStatus, QuestionMemoryLeads, StoredMemoryLead } from '#shared/types/memory'
import { leadLine, memoryLastCheck, memoryLogLine, memoryUrl, pingMemory, searchMemory, type MemoryResult } from './memory'
import { isLegacyQuestion, type QuestionRow } from './questions'
import { parseJson } from './review'

// Leads from Devin's past Claude sessions, looked up ahead of time for pending questions and
// stored on the question row. The card shows them as leads (date, project, one quoted line) and
// opens the chat with them; nothing here ever writes an answer or a knowledge entry.

export const LEAD_LIMITS = {
  /** Leads stored per question. */
  perQuestion: 3,
  /** Excerpts the chat sends to Claude. */
  perChat: 5,
  /** A question checked more recently than this is not searched again by the daily run. */
  freshDays: 3,
  /** Questions searched in one run. */
  maxQuestions: 40,
  /** One run stops after this long, so it never holds up the rest of the daily chain. */
  maxMs: 8 * 60 * 1000,
  /** Searches that fail in a row before the run stops (the laptop went to sleep). */
  giveUpAfter: 3,
  /**
   * Pause before retrying a failed search. The memory server is shared with every Claude session
   * on the laptop, and a search that runs past the 15 second limit keeps it busy for a while.
   */
  retryPauseMs: 20_000,
} as const

export const MEMORY_TASK = 'memory:leads'

/** Free-text questions and skill or experience questions get leads; facts, preferences, numbers, and choices do not. */
export function takesLeads(q: QuestionRow): boolean {
  if (isLegacyQuestion(q)) return true
  if (q.kind === 'knows' || q.kind === 'has_done') return true
  if (q.kind === 'fact' || q.kind === 'preference') return false
  return q.answerType === 'text'
}

/** The question itself, plus its subject for a skill or experience question ("SCIM and passkeys in production"). */
export function memoryQueries(q: Pick<QuestionRow, 'question' | 'subject' | 'kind'>): string[] {
  const out = [q.question]
  const subject = q.subject?.trim()
  if (subject && subject.length >= 3 && (q.kind === 'knows' || q.kind === 'has_done') && !q.question.toLowerCase().includes(subject.toLowerCase())) out.push(subject)
  return out
}

export function toStoredLeads(results: MemoryResult[], question: string, n: number): StoredMemoryLead[] {
  return results.slice(0, n).map(r => ({
    date: r.date,
    project: r.project,
    line: leadLine(r.excerpt, question),
    excerpt: r.excerpt,
    score: r.score,
  }))
}

export function storedLeads(q: Pick<QuestionRow, 'memoryLeadsJson'>): QuestionMemoryLeads | null {
  const v = parseJson<QuestionMemoryLeads | null>(q.memoryLeadsJson, null)
  return v && Array.isArray(v.leads) ? v : null
}

/** GET /api/memory/leads: pending questions with at least one lead, without the excerpts. */
export function pendingLeads(): MemoryLeadsResponse {
  const byQuestion: MemoryLeadsResponse['byQuestion'] = {}
  if (!memoryUrl()) return { byQuestion }
  const rows = useDb().select({ id: questions.id, memoryLeadsJson: questions.memoryLeadsJson }).from(questions)
    .where(and(eq(questions.status, 'pending'), isNotNull(questions.memoryLeadsJson))).all()
  for (const row of rows) {
    const v = storedLeads(row)
    if (!v?.leads.length) continue
    byQuestion[row.id] = { checkedAt: v.checkedAt, leads: v.leads.map(l => ({ date: l.date, project: l.project, line: l.line })) }
  }
  return { byQuestion }
}

/**
 * The memory:leads task. Best effort: when memory is off or the laptop cannot be reached it
 * returns a plain note and changes nothing. Stats hold counts and the note only, never excerpt
 * text, because withRun logs them and stores them in pipeline_runs.
 */
export async function refreshMemoryLeads(log: (msg: string) => void, opts: { force?: boolean } = {}) {
  const url = memoryUrl()
  if (!url) return { checked: 0, note: 'Memory is off (NUXT_MEMORY_MCP_URL is not set), so no leads were looked up.' }
  let ping = await pingMemory(url)
  if (!ping.ok) {
    log(`[memory] not reachable (${ping.reason}); trying once more in ${LEAD_LIMITS.retryPauseMs / 1000} seconds`)
    await new Promise(r => setTimeout(r, LEAD_LIMITS.retryPauseMs))
    ping = await pingMemory(url)
  }
  if (!ping.ok) return { checked: 0, note: `Your laptop's memory is not reachable right now (${ping.reason}), so no leads were looked up.` }

  const db = useDb()
  const pending = db.select().from(questions).where(eq(questions.status, 'pending')).all().filter(takesLeads)
  const freshAfter = Date.now() - LEAD_LIMITS.freshDays * 86_400_000
  const due = pending
    .filter(q => opts.force || !(Date.parse(storedLeads(q)?.checkedAt ?? '') > freshAfter))
    .sort((a, b) => Number(b.blocking) - Number(a.blocking) || b.id - a.id)
    .slice(0, LEAD_LIMITS.maxQuestions)
  const started = Date.now()
  let checked = 0
  let withLeads = 0
  let leadsStored = 0
  let unreachable = 0
  let inARow = 0
  let note: string | null = null
  const outOfTime = () => Date.now() - started > LEAD_LIMITS.maxMs
  for (const q of due) {
    if (outOfTime()) {
      note = `Stopped after ${checked} questions to keep the daily run moving; the rest are checked next time.`
      break
    }
    let search = await searchMemory(url, memoryQueries(q), { question: q.question })
    log(memoryLogLine(`question ${q.id}`, search))
    // One retry after a pause: a busy server usually answers the second time.
    if (!search.available && !outOfTime()) {
      await new Promise(r => setTimeout(r, LEAD_LIMITS.retryPauseMs))
      search = await searchMemory(url, memoryQueries(q), { question: q.question })
      log(memoryLogLine(`question ${q.id}, retry`, search))
    }
    if (!search.available) {
      unreachable++
      if (++inARow >= LEAD_LIMITS.giveUpAfter) {
        note = `Your laptop's memory stopped answering after ${checked} questions (${search.reason}); the rest are checked next time.`
        break
      }
      continue
    }
    inARow = 0
    const leads = toStoredLeads(search.results, q.question, LEAD_LIMITS.perQuestion)
    const value: QuestionMemoryLeads = { checkedAt: new Date().toISOString(), leads }
    db.update(questions).set({ memoryLeadsJson: JSON.stringify(value) }).where(eq(questions.id, q.id)).run()
    checked++
    if (leads.length) withLeads++
    leadsStored += leads.length
  }
  return {
    questions: pending.length,
    checked,
    withLeads,
    leadsStored,
    checkedRecently: pending.length - due.length,
    ...(unreachable ? { unreachable } : {}),
    ...(note ? { note } : {}),
  }
}

/** Settings > Memory: off, reachable, or not reachable, and when that was last checked. */
export function memoryStatus(): MemoryStatus {
  const run = useDb().select().from(pipelineRuns).where(eq(pipelineRuns.task, MEMORY_TASK)).orderBy(desc(pipelineRuns.id)).limit(1).get()
  const stats = parseJson<Record<string, unknown> | null>(run?.statsJson, null)
  const runAt = run ? (run.finishedAt ?? run.startedAt) : null
  const lastLeadsRun = run && runAt
    ? {
        at: `${runAt.replace(' ', 'T')}Z`,
        note: typeof stats?.note === 'string' ? stats.note : (run.status === 'failed' ? 'The last run failed.' : null),
        questionsWithLeads: typeof stats?.withLeads === 'number' ? stats.withLeads : null,
      }
    : null
  if (!memoryUrl()) return { state: 'off', checkedAt: null, reason: null, lastLeadsRun }
  const check = memoryLastCheck()
  if (check) return { state: check.ok ? 'reachable' : 'unreachable', checkedAt: check.at, reason: check.reason, lastLeadsRun }
  // After a restart, the last leads run is the latest word.
  if (lastLeadsRun && stats) {
    const down = typeof stats.note === 'string' && /not reachable|stopped answering/.test(stats.note)
    return { state: down ? 'unreachable' : 'reachable', checkedAt: lastLeadsRun.at, reason: null, lastLeadsRun }
  }
  return { state: 'unknown', checkedAt: null, reason: null, lastLeadsRun }
}

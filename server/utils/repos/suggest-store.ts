import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { repoCommits, repoSuggestions, taskQueue } from '../../db/schema'
import type { RepoEvidence, RepoSuggestionView } from '#shared/types/repos'
import { recordNameList, withoutRecordNames } from './describe'

// Reads stored GitHub suggestions for the question views, and queues a suggestion run when a new
// skill or experience question is asked. Kept apart from suggest.ts so questions.ts and review.ts
// can import it without pulling in the search code.

export function parseEvidence(json: string | null): RepoEvidence[] {
  try {
    const list = JSON.parse(json ?? '[]')
    return Array.isArray(list) ? list.filter(e => e && typeof e.url === 'string' && typeof e.sha === 'string') : []
  }
  catch {
    return []
  }
}

/** Suggestions for the given question ids that have evidence (status suggested). Others are absent. */
export function repoSuggestionsFor(questionIds: number[]): Map<number, RepoSuggestionView> {
  const out = new Map<number, RepoSuggestionView>()
  if (!questionIds.length) return out
  const rows = useDb().select().from(repoSuggestions)
    .where(and(inArray(repoSuggestions.questionId, questionIds), eq(repoSuggestions.status, 'suggested')))
    .all()
  // A draft stored before the no-names rule still names a repo or client; the card gets it described.
  const names = rows.length ? recordNameList() : []
  for (const r of rows) {
    const evidence = parseEvidence(r.evidenceJson)
    if (!evidence.length || (r.level !== 'Yes' && r.level !== 'Some experience') || !r.draft) continue
    out.set(r.questionId, { level: r.level, draft: withoutRecordNames(r.draft, names), evidence, createdAt: r.createdAt })
  }
  return out
}

// ── On-ask queue ──

/** How long a new question waits, so questions asked together share one suggestion run. */
const GATHER_MS = 45_000

/**
 * A new knows or has_done question was asked: suggest from GitHub within a minute, when any
 * repo is indexed. Adds a repos:suggest item to the job queue 45 seconds out, or adds the
 * question to one that is still waiting. Off where the schedule is off (every Orca worktree), so a
 * laptop copy never calls Claude on its own; the daily run's repos:suggest step covers it there.
 * Questions asked inside a daily run get its last step, repos:suggest, instead.
 */
export function queueRepoSuggest(questionId: number) {
  try {
    if (String(useRuntimeConfig().schedulerEnabled) === 'false') return
    const db = useDb()
    const indexed = db.select({ n: sql<number>`count(*)` }).from(repoCommits).get()?.n ?? 0
    if (!indexed) return
    if (dailyInFlight()) return
    useDb().$client.transaction(() => {
      const waiting = db.select().from(taskQueue)
        .where(and(eq(taskQueue.task, 'repos:suggest'), eq(taskQueue.status, 'queued'), isNull(taskQueue.parentId)))
        .orderBy(taskQueue.id).limit(1).get()
      if (waiting) {
        const p = parsePayload(waiting)
        const ids = Array.isArray(p.questionIds) ? p.questionIds.map(Number) : []
        if (!ids.includes(questionId)) {
          db.update(taskQueue).set({ payloadJson: JSON.stringify({ ...p, questionIds: [...ids, questionId] }) }).where(eq(taskQueue.id, waiting.id)).run()
        }
        return
      }
      enqueue('repos:suggest', { questionIds: [questionId] }, { trigger: 'chained', runAfter: new Date(Date.now() + GATHER_MS) })
    }).immediate()
  }
  catch (e) {
    console.warn('[repos] could not queue a suggestion run', e)
  }
}

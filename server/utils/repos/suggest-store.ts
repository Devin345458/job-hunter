import { and, eq, inArray, sql } from 'drizzle-orm'
import { repoCommits, repoSuggestions } from '../../db/schema'
import type { RepoEvidence, RepoSuggestionView } from '#shared/types/repos'

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
  for (const r of rows) {
    const evidence = parseEvidence(r.evidenceJson)
    if (!evidence.length || (r.level !== 'Yes' && r.level !== 'Some experience') || !r.draft) continue
    out.set(r.questionId, { level: r.level, draft: r.draft, evidence, createdAt: r.createdAt })
  }
  return out
}

// ── On-ask queue ──

let queued = new Set<number>()
let timer: ReturnType<typeof setTimeout> | null = null

/**
 * A new knows or has_done question was asked: suggest from GitHub within a minute, when any
 * repo is indexed. Off where the schedule is off (every Orca worktree), so a laptop copy never
 * calls Claude on its own. The daily run's repos:suggest step covers it there.
 */
export function queueRepoSuggest(questionId: number) {
  try {
    if (String(useRuntimeConfig().schedulerEnabled) === 'false') return
    queued.add(questionId)
    if (!timer) timer = setTimeout(flushQueue, 45_000)
  }
  catch (e) {
    console.warn('[repos] could not queue a suggestion run', e)
  }
}

async function flushQueue() {
  timer = null
  const ids = [...queued]
  queued = new Set()
  if (!ids.length) return
  try {
    const indexed = useDb().select({ n: sql<number>`count(*)` }).from(repoCommits).get()?.n ?? 0
    if (!indexed) return
    const res: any = await runTask('repos:suggest', { payload: { trigger: 'chained', questionIds: ids } })
    if (res?.result?.status === 'skipped') {
      for (const id of ids) queued.add(id)
      timer = setTimeout(flushQueue, 120_000)
    }
  }
  catch (e) {
    console.error('[repos] suggestion run for new questions failed', e)
  }
}

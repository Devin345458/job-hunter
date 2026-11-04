import type { RecordsDraftResponse, RecordsDraftStatus, RecordsDraftStep } from '#shared/types/question-chat'
import { draftFromRecords } from './draft-from-records'

// One "Draft from my records" at a time per question, in this server process. A second press, a
// second tab, or a page reloaded while a draft runs joins the running draft instead of starting
// another one (production once ran the same question twice within a minute). The run also holds
// the step the draft is on, which GET /api/questions/:id/draft reports for the line under the
// spinner, and the finished result for a few minutes, so a page whose request was cut off (the
// proxy in front of production stops a request at 100 seconds) still gets its draft.
// Drafts run in a request on the web process, never in the job queue, so memory is the right place.

/** How long a finished draft stays collectable. */
export const RECORDS_RUN_KEEP_MS = 5 * 60 * 1000

interface RecordsRun {
  startedAt: number
  step: RecordsDraftStep | null
  label: string | null
  promise: Promise<RecordsDraftResponse>
  result: RecordsDraftResponse | null
  finishedAt: number | null
}

const runs = new Map<number, RecordsRun>()

function prune(now = Date.now()) {
  for (const [id, r] of runs) {
    if (r.finishedAt && now - r.finishedAt > RECORDS_RUN_KEEP_MS) runs.delete(id)
  }
}

/**
 * The draft running for this question, or a new one. A finished draft never blocks a new one:
 * "Draft again" after it finished starts fresh. A draft that throws (a question that takes no
 * draft) is forgotten at once, and the error reaches every caller waiting on it.
 */
export function startRecordsDraft(questionId: number, said: string[]): { promise: Promise<RecordsDraftResponse>; joined: boolean } {
  prune()
  const running = runs.get(questionId)
  if (running && !running.result) {
    console.info(`[draft-from-records] question ${questionId}: a draft is already running, joined it`)
    return { promise: running.promise, joined: true }
  }
  const run: RecordsRun = { startedAt: Date.now(), step: null, label: null, promise: Promise.resolve(null as never), result: null, finishedAt: null }
  run.promise = draftFromRecords(questionId, said, (step, label) => {
    run.step = step
    run.label = label
  }).then((res) => {
    run.result = res
    run.finishedAt = Date.now()
    console.info(`[draft-from-records] question ${questionId}: done in ${Math.round((run.finishedAt - run.startedAt) / 1000)} seconds`)
    return res
  }, (e) => {
    if (runs.get(questionId) === run) runs.delete(questionId)
    throw e
  })
  // A caller that stopped waiting (the request answered "still running") must not leave the
  // rejection unhandled; callers still waiting get it.
  run.promise.catch(() => {})
  runs.set(questionId, run)
  return { promise: run.promise, joined: false }
}

/** What GET /api/questions/:id/draft returns. */
export function recordsDraftStatus(questionId: number): RecordsDraftStatus {
  prune()
  const r = runs.get(questionId)
  if (!r) return { running: false, step: null, label: null, startedAt: null, result: null }
  return {
    running: !r.result,
    step: r.result ? null : r.step,
    label: r.result ? null : r.label,
    startedAt: new Date(r.startedAt).toISOString(),
    result: r.result,
  }
}

/** The draft's result, or null when it is still running after `ms`. */
export async function waitForRecordsDraft(promise: Promise<RecordsDraftResponse>, ms: number): Promise<RecordsDraftResponse | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
  })
  try {
    return await Promise.race([promise, late])
  }
  finally {
    clearTimeout(timer)
  }
}

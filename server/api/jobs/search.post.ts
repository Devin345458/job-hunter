import { eq } from 'drizzle-orm'
import { pipelineRuns, searchConfigs } from '~~/server/db/schema'
import type { SearchRunStats } from '~~/server/utils/job-sources'

/** How long the request waits for the search before answering that it is still queued. */
const WAIT_MS = 120_000

// "Search now" on the jobs page. Adds the jobs:search task to the job queue (trigger manual), so the
// run lands in pipeline_runs (Settings, Recent runs) like every other run, and waits up to two
// minutes for it so the page can say how many new jobs it found. Behind a long item in the queue,
// it answers 202 with queued: true and a sentence saying so; the jobs show up when it runs.
export default defineEventHandler(async (event) => {
  const active = useDb().select({ id: searchConfigs.id }).from(searchConfigs).where(eq(searchConfigs.isActive, true)).all()
  if (!active.length) {
    throw createError({ statusCode: 400, statusMessage: 'No search configuration is switched on. Turn one on in Settings, Search Configurations.' })
  }

  const { item: queued } = enqueue('jobs:search', {}, { trigger: 'manual', existing: () => {
    const waiting = activeItem('jobs:search')
    return waiting && !waiting.parentId ? waiting : null
  } })
  const item = await waitForItem(queued.id, WAIT_MS)
  if (!item || !isTerminal(item.status)) {
    setResponseStatus(event, 202)
    const behind = waitingText().replace(/^Waiting in the queue/, '')
    return {
      queued: true,
      runId: item?.pipelineRunId ?? null,
      status: 'queued',
      message: item?.status === 'running'
        ? 'The search is still running. New jobs show up here when it finishes.'
        : `The search is waiting in the queue${behind}. New jobs show up here when it runs.`,
      jobsFound: 0,
      found: 0,
    }
  }
  const run = item.pipelineRunId ? useDb().select().from(pipelineRuns).where(eq(pipelineRuns.id, item.pipelineRunId)).get() : null
  if (!run) {
    throw createError({ statusCode: 500, statusMessage: item.lastError ? `The job search failed: ${item.lastError}` : 'The search task returned no result.' })
  }
  if (run.status === 'skipped') {
    throw createError({ statusCode: 409, statusMessage: 'A job search is already running. Its results will show here when it finishes.', data: { runId: run.id } })
  }
  const stats = parseJson<SearchRunStats | null>(run.statsJson, null)
  if (run.status === 'failed' || !stats) {
    // The full error is on the pipeline_runs row; the first line is enough here.
    const reason = (run.error || item.lastError || 'unknown error').split('\n')[0]!.slice(0, 300)
    throw createError({ statusCode: 502, statusMessage: `The job search failed: ${reason}`, data: { runId: run.id } })
  }

  return {
    runId: run.id,
    status: run.status,
    message: `Found ${stats.found} listings, ${stats.new} new`,
    jobsFound: stats.new,
    found: stats.found,
  }
})

import { eq } from 'drizzle-orm'
import { searchConfigs } from '~~/server/db/schema'
import type { SearchRunStats } from '~~/server/utils/job-sources'

// "Search now" on the jobs page. Runs the jobs:search task itself, through Nitro's runTask with
// trigger manual, so the run lands in pipeline_runs (Settings, Recent runs) like every other run.
// Waits for the run so the page can say how many new jobs it found.
export default defineEventHandler(async () => {
  const active = useDb().select({ id: searchConfigs.id }).from(searchConfigs).where(eq(searchConfigs.isActive, true)).all()
  if (!active.length) {
    throw createError({ statusCode: 400, statusMessage: 'No search configuration is switched on. Turn one on in Settings, Search Configurations.' })
  }

  const { result } = await runTask('jobs:search', { payload: { trigger: 'manual' } }) as {
    result?: { runId: number; status: 'succeeded' | 'failed' | 'skipped'; stats: SearchRunStats | null; error: string | null }
  }
  if (!result) {
    throw createError({ statusCode: 500, statusMessage: 'The search task returned no result.' })
  }
  if (result.status === 'skipped') {
    throw createError({ statusCode: 409, statusMessage: 'A job search is already running. Its results will show here when it finishes.', data: { runId: result.runId } })
  }
  if (result.status === 'failed' || !result.stats) {
    // The full error is on the pipeline_runs row; the first line is enough here.
    const reason = (result.error || 'unknown error').split('\n')[0]!.slice(0, 300)
    throw createError({ statusCode: 502, statusMessage: `The job search failed: ${reason}`, data: { runId: result.runId } })
  }

  const stats = result.stats
  return {
    runId: result.runId,
    status: result.status,
    // found counts every listing read (14 days, or since the last pull); passed is what met the filters.
    message: `Read ${stats.found.toLocaleString('en-US')} listings, ${(stats.passed ?? stats.found).toLocaleString('en-US')} passed your filters, ${stats.new} new`,
    jobsFound: stats.new,
    found: stats.found,
  }
})

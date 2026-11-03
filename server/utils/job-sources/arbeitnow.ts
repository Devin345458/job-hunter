import type { PullContext, PullResult, RawListing, SearchParams } from './types'
import { fetchJson } from './http'
import { aggregator, pagedPull, scoped, toIso, toTime, windowStart } from './paging'

// Arbeitnow lists mostly European jobs; only US-eligible remote listings pass the filter.
// Paging: ?page=N with links.next, 200 to 300 per page, roughly newest first by created_at (epoch
// seconds), and neighboring pages overlap, so listings are deduped on slug and paging stops at
// the first page that is entirely older than the window. Its remote=true parameter is ignored by
// the API, so remote is checked in code. Terms: "free public API, please do not abuse", link back.

function toListing(job: any): RawListing {
  return {
    job: {
      source: 'arbeitnow',
      sourceId: job.slug,
      title: job.title || 'Unknown',
      company: job.company_name || 'Unknown',
      location: job.location || 'Unknown',
      remoteType: job.remote ? 'remote' : 'onsite',
      description: job.description || '',
      url: job.url || `https://www.arbeitnow.com/jobs/${job.slug}`,
      tags: job.tags || [],
    },
    postedAt: toIso(job.created_at ?? null),
    locations: job.location ? [job.location] : [],
    remote: !!job.remote,
    fullTime: !(job.job_types ?? []).some((t: string) => /intern|part[\s_-]?time|freelance|werkstudent|mini/i.test(t)),
  }
}

export const arbeitnowAdapter = aggregator({
  name: 'arbeitnow',
  overlapHours: 6,

  async pull(_params: SearchParams, ctx: PullContext): Promise<PullResult> {
    return scoped('', async () => {
      const { items, result } = await pagedPull<any>({
        scope: '',
        start: windowStart(ctx, ''),
        firstPage: 1,
        maxPages: 60,
        stop: 'all-older',
        timeOf: job => toTime(job.created_at ?? null),
        idOf: job => String(job.slug),
        fetchPage: async (page) => {
          const data = await fetchJson<any>(`https://www.arbeitnow.com/api/job-board-api?page=${page}`, { minIntervalMs: 1000, cache: true })
          return { items: (data?.data ?? []).filter((j: any) => j?.slug), last: !data?.links?.next }
        },
      })
      return { listings: items.map(toListing), result }
    })
  },
})

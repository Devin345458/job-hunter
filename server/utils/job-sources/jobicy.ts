import type { PullContext, PullResult, RawListing, SearchParams } from './types'
import { fetchJson } from './http'
import { aggregator, pagedPull, scoped, toIso, toTime, windowStart } from './paging'

// Jobicy API (jobicy.com/jobs-rss-feed): US remote engineering jobs, newest first, 100 per page,
// cursor paging (nextCursor, hasMore). It only serves the last 7 days and delays listings about 3
// hours. Its docs ask for a new pass no more than once an hour, following the cursor pages in
// order, and for apply links to keep pointing at Jobicy. The tag parameter is case-sensitive, so
// keywords are matched in code.

function toListing(job: any): RawListing {
  return {
    job: {
      source: 'jobicy',
      sourceId: String(job.id),
      title: job.jobTitle || 'Unknown',
      company: job.companyName || 'Unknown',
      location: job.jobGeo || 'Remote',
      remoteType: 'remote',
      salaryMin: job.annualSalaryMin || job.salaryMin || undefined,
      salaryMax: job.annualSalaryMax || job.salaryMax || undefined,
      salaryCurrency: job.salaryCurrency || 'USD',
      description: job.jobDescription || job.jobExcerpt || '',
      url: job.url || `https://jobicy.com/jobs/${job.id}`,
      tags: Array.isArray(job.jobIndustry) ? job.jobIndustry : [],
    },
    postedAt: toIso(job.pubDate ?? null),
    locations: job.jobGeo ? [job.jobGeo] : [],
    remote: true,
    fullTime: !/intern|part[\s_-]?time|freelance/i.test(Array.isArray(job.jobType) ? job.jobType.join(' ') : String(job.jobType ?? '')),
    usOnly: true,
  }
}

export const jobicyAdapter = aggregator({
  name: 'jobicy',
  minIntervalMinutes: 60,
  overlapHours: 6,

  async pull(_params: SearchParams, ctx: PullContext): Promise<PullResult> {
    return scoped('', async () => {
      const { items, result } = await pagedPull<any>({
        scope: '',
        start: windowStart(ctx, ''),
        maxPages: 20,
        stop: 'last-older',
        timeOf: job => toTime(job.pubDate ?? null),
        idOf: job => String(job.id),
        fetchPage: async (_page, cursor) => {
          const query = new URLSearchParams({ count: '100', geo: 'usa', industry: 'engineering' })
          if (cursor) query.set('cursor', cursor)
          const data = await fetchJson<any>(`https://jobicy.com/api/jobs?${query}`, { minIntervalMs: 1000, cache: true })
          return { items: data?.jobs ?? [], next: data?.hasMore ? data.nextCursor : null }
        },
      })
      return { listings: items.map(toListing), result }
    })
  },
})

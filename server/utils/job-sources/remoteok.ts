import type { PullContext, PullResult, RawListing, SearchParams } from './types'
import { fetchJson } from './http'
import { aggregator, toIso, windowStart } from './paging'

// RemoteOK returns its newest listings (about 100) in one call and has no paging; the first
// element is legal text. Terms: link back to the listing on Remote OK and name it as the source.
// Every listing inside the window is kept (the old adapter kept the first 50 matches).

function toListing(job: any): RawListing {
  return {
    job: {
      source: 'remoteok',
      sourceId: String(job.id),
      title: job.position || 'Unknown',
      company: job.company || 'Unknown',
      location: job.location || 'Remote',
      remoteType: 'remote',
      salaryMin: job.salary_min > 0 ? job.salary_min : undefined,
      salaryMax: job.salary_max > 0 ? job.salary_max : undefined,
      salaryCurrency: job.salary_min > 0 ? 'USD' : undefined,
      description: job.description || '',
      url: job.apply_url || job.url || `https://remoteok.com/remote-jobs/${job.slug}`,
      tags: job.tags || [],
    },
    postedAt: toIso(job.epoch ?? job.date ?? null),
    locations: job.location ? [job.location] : [],
    remote: true,
    fullTime: true,
  }
}

export const remoteokAdapter = aggregator({
  name: 'remoteok',
  overlapHours: 2,

  async pull(_params: SearchParams, ctx: PullContext): Promise<PullResult> {
    const response = await fetchJson<any[]>('https://remoteok.com/api', { cache: true })
    const start = windowStart(ctx, '').getTime()
    const listings = (Array.isArray(response) ? response : [])
      .filter((job: any) => job?.id && job.position)
      .map(toListing)
      .filter(l => !l.postedAt || Date.parse(l.postedAt) >= start)
    return {
      listings: listings.map(l => ({ ...l, scope: '' })),
      scopes: [{ scope: '', ok: true, found: listings.length, requests: 1, complete: true }],
    }
  },
})

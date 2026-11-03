import type { PullContext, PullResult, RawListing, SearchParams } from './types'
import { fetchJson } from './http'
import { aggregator, mergeResults, pagedPull, scoped, toIso, toTime, windowStart } from './paging'

// Himalayas public API (himalayas.app/docs/remote-jobs-api). The full feed holds over 100,000
// listings ordered by last update (about 6,000 a day), so this uses the keyword search endpoint,
// one query per keyword (its own watermark scope), sorted by most recent, 20 per page, paged until
// a page is entirely older than the window. Its order is only roughly by date.
//
// Terms (himalayas.app/terms): apply through the applicationLink the API gives, credit Himalayas,
// remove jobs once they expire. Without a key all callers share one allowance, and the docs say
// there is no benefit to polling more than once a day, so this pulls at most once every 20 hours
// with requests 1.5 seconds apart. pubDate is the last update time, in epoch seconds.

interface HimalayasJob {
  title: string
  excerpt?: string
  companyName?: string
  employmentType?: string
  minSalary?: number | null
  maxSalary?: number | null
  salaryPeriod?: string | null
  currency?: string | null
  locationRestrictions?: Array<string | { name?: string }>
  categories?: string[]
  description?: string
  pubDate?: number | string
  applicationLink?: string
  guid?: string
}

function locationsOf(j: HimalayasJob): string[] {
  return (j.locationRestrictions ?? []).map(l => (typeof l === 'string' ? l : l?.name ?? '')).filter(Boolean)
}

function toListing(j: HimalayasJob): RawListing {
  const yearly = !j.salaryPeriod || /year|annual/i.test(j.salaryPeriod)
  const locations = locationsOf(j)
  return {
    job: {
      source: 'himalayas',
      sourceId: j.guid || j.applicationLink || j.title,
      title: j.title || 'Unknown',
      company: j.companyName || 'Unknown',
      location: locations.length > 6 ? 'Remote (many countries, including the United States)' : locations.join(', ') || 'Remote',
      remoteType: 'remote',
      salaryMin: yearly ? j.minSalary || undefined : undefined,
      salaryMax: yearly ? j.maxSalary || undefined : undefined,
      salaryCurrency: j.currency || 'USD',
      description: j.description || j.excerpt || '',
      url: j.applicationLink || j.guid,
      tags: j.categories || [],
    },
    postedAt: toIso(j.pubDate ?? null),
    locations,
    remote: true,
    fullTime: !/intern|part/i.test(j.employmentType ?? ''),
  }
}

export const himalayasAdapter = aggregator({
  name: 'himalayas',
  minIntervalMinutes: 20 * 60,
  // The search index lagged the main feed by about 9 hours when checked.
  overlapHours: 24,

  async pull(params: SearchParams, ctx: PullContext): Promise<PullResult> {
    const results: PullResult[] = []
    for (const keyword of params.keywords) {
      const scope = keyword.trim().toLowerCase()
      results.push(await scoped(scope, async () => {
        const { items, result } = await pagedPull<HimalayasJob>({
          scope,
          start: windowStart(ctx, scope),
          firstPage: 1,
          // The search caps at 5,000 results, 250 pages of 20.
          maxPages: 250,
          stop: 'all-older',
          timeOf: j => toTime(j.pubDate ?? null),
          idOf: j => j.guid || j.applicationLink || j.title,
          fetchPage: async (page) => {
            const query = new URLSearchParams({ q: keyword, sort: 'recent', page: String(page) })
            const data = await fetchJson<{ jobs?: HimalayasJob[] }>(`https://himalayas.app/jobs/api/search?${query}`, { minIntervalMs: 1500, cache: true })
            return { items: data.jobs ?? [] }
          },
        })
        return { listings: items.map(toListing), result }
      }))
    }
    return mergeResults(results)
  },
})

import type { PullContext, PullResult, RawListing, SearchParams } from './types'
import { sanitizeHtml } from './filters'
import { fetchJson } from './http'
import { aggregator, toIso, windowStart } from './paging'

// Working Nomads public API (www.workingnomads.com/api/exposed_jobs/, linked from the site's own
// footer): its latest remote jobs in one call, no paging. Each job links to its Working Nomads page.

interface NomadJob {
  url: string
  title: string
  description?: string
  company_name?: string
  category_name?: string
  tags?: string
  location?: string
  pub_date?: string
}

export const workingnomadsAdapter = aggregator({
  name: 'workingnomads',
  overlapHours: 2,
  async pull(_params: SearchParams, ctx: PullContext): Promise<PullResult> {
    const start = windowStart(ctx, '').getTime()
    const data = await fetchJson<NomadJob[]>('https://www.workingnomads.com/api/exposed_jobs/', { cache: true })
    const listings: RawListing[] = (Array.isArray(data) ? data : [])
      .filter(j => j.url && j.title)
      .map(j => ({
        job: {
          source: 'workingnomads',
          sourceId: j.url.match(/(\d+)\/?$/)?.[1] ?? j.url,
          title: j.title.trim(),
          company: j.company_name?.trim() || 'Unknown',
          location: j.location || 'Remote',
          remoteType: 'remote' as const,
          description: sanitizeHtml(j.description ?? ''),
          url: j.url,
          tags: [j.category_name, ...(j.tags ?? '').split(',')].map(t => t?.trim()).filter((t): t is string => !!t),
        },
        postedAt: toIso(j.pub_date ?? null),
        locations: j.location ? [j.location] : [],
        remote: true,
        fullTime: true,
      }))
      .filter(l => !l.postedAt || Date.parse(l.postedAt) >= start)
    return {
      listings: listings.map(l => ({ ...l, scope: '' })),
      scopes: [{ scope: '', ok: true, found: listings.length, requests: 1, complete: true }],
    }
  },
})

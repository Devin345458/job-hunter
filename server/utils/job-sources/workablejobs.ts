import type { PullContext, PullResult, RawListing, SearchParams } from './types'
import { looksRemote, sanitizeHtml } from './filters'
import { fetchJson } from './http'
import { aggregator, mergeResults, pagedPull, scoped, toIso, toTime, windowStart } from './paging'
import { parseListedSalary } from './remotive'

// Workable's public job board search (jobs.workable.com/api/v1/jobs): every Workable employer's
// open jobs, searchable by keyword, workplace, and location, 20 per page with a page token. One
// query per keyword (its own watermark scope), US locations, remote when the config is remote-only.
// Workable does not document this endpoint, so it can change without notice; its robots.txt does
// not disallow /api and its job board terms have no clause against automated reading.

interface WorkableSearchJob {
  id: string
  title: string
  description?: string
  requirementsSection?: string
  benefitsSection?: string
  employmentType?: string
  url?: string
  locations?: string[]
  location?: { city?: string; subregion?: string | null; countryName?: string }
  created?: string
  updated?: string
  company?: { title?: string; website?: string }
  workplace?: string
}

function toListing(j: WorkableSearchJob): RawListing {
  const place = [j.location?.city, j.location?.subregion, j.location?.countryName].filter(Boolean).join(', ')
  const remote = /remote/i.test(j.workplace ?? '') || looksRemote(j.title)
  const pay = parseListedSalary((j.benefitsSection ?? '').replace(/<[^>]+>/g, ' ').match(/\$[\d,.]+k?(?:\s*(?:-|\u2013|to)\s*\$?[\d,.]+k?)?(?:\s*(?:per|\/)\s*(?:year|yr|hour|hr))?/i)?.[0] ?? null)
  return {
    job: {
      source: 'workablejobs',
      sourceId: j.id,
      title: j.title.trim(),
      company: j.company?.title?.trim() || 'Unknown',
      companyUrl: j.company?.website || undefined,
      location: place || (j.locations ?? []).join(', ') || undefined,
      remoteType: remote ? 'remote' : /hybrid/i.test(j.workplace ?? '') ? 'hybrid' : undefined,
      salaryMin: pay?.min,
      salaryMax: pay?.max,
      salaryCurrency: pay ? 'USD' : undefined,
      description: sanitizeHtml([j.description, j.requirementsSection, j.benefitsSection].filter(Boolean).join('\n')),
      url: j.url,
      tags: [],
    },
    postedAt: toIso(j.updated ?? j.created ?? null),
    locations: [place, ...(j.locations ?? []).filter(l => l !== 'TELECOMMUTE')].filter(Boolean),
    remote,
    fullTime: !/part|contract|temporary|intern/i.test(j.employmentType ?? ''),
  }
}

export const workablejobsAdapter = aggregator({
  name: 'workablejobs',
  overlapHours: 2,
  async pull(params: SearchParams, ctx: PullContext): Promise<PullResult> {
    const results: PullResult[] = []
    for (const keyword of params.keywords) {
      const scope = keyword.trim().toLowerCase()
      results.push(await scoped(scope, async () => {
        const { items, result } = await pagedPull<WorkableSearchJob>({
          scope,
          start: windowStart(ctx, scope),
          maxPages: 100,
          stop: 'all-older',
          timeOf: j => toTime(j.updated ?? j.created ?? null),
          idOf: j => j.id,
          fetchPage: async (_page, cursor) => {
            const query = new URLSearchParams({ query: keyword, location: 'United States' })
            if (params.remoteOnly) query.set('workplace', 'remote')
            if (cursor) query.set('pageToken', cursor)
            const data = await fetchJson<{ jobs?: WorkableSearchJob[]; nextPageToken?: string | null }>(`https://jobs.workable.com/api/v1/jobs?${query}`, { cache: true, minIntervalMs: 1000 })
            return { items: data.jobs ?? [], next: data.nextPageToken || null }
          },
        })
        return { listings: items.map(toListing), result }
      }))
    }
    return mergeResults(results)
  },
})

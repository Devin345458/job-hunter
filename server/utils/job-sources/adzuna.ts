import type { PullContext, PullResult, RawListing, SearchParams } from './types'
import { SourceUnavailable } from './types'
import { looksRemote } from './filters'
import { fetchJson, HttpError } from './http'
import { aggregator, mergeResults, pagedPull, scoped, toIso, toTime, windowStart } from './paging'

// Adzuna search API: https://developer.adzuna.com/docs/search
//
// Two bugs made this source return nothing in production:
// - The February build sent `content_type=application/json`. Adzuna does not know that
//   parameter and answers 400 with an HTML error page.
// - The rewrite after it put every keyword in `what` joined by "OR". `what` requires every
//   word, including the literal word "OR", so it matched zero listings.
// Now: one query per keyword with `title_only` (all its words must be in the title),
// `what=remote` when the config is remote-only, newest first, paged until the listings are older
// than the window. Each keyword is its own watermark scope; `max_days_old` narrows the query to
// the days since the watermark. Excluded terms and the pay floor are applied in code on the title
// and the stated salary, because `what_exclude` searches the whole description ("entry level"
// would drop every listing that says "level").
//
// Adzuna does not publish its limits (they are shown in the account). The widely cited defaults
// are 25 requests a minute and 250 a day, so requests are spaced 2.6 seconds apart and a full
// 14-day pull of Devin's five keywords is about 35 requests.

interface AdzunaResult {
  id: string | number
  title: string
  description?: string
  redirect_url: string
  created?: string
  company?: { display_name?: string }
  location?: { display_name?: string; area?: string[] }
  salary_min?: number
  salary_max?: number
  salary_is_predicted?: string | number
  contract_time?: string
  category?: { tag?: string; label?: string }
}

const PER_PAGE = 50

function toListing(r: AdzunaResult): RawListing {
  // Adzuna fills salary_min/max with its own prediction when the employer gave none.
  // A predicted number is Adzuna's guess, not the employer's, so it is never stored.
  const stated = String(r.salary_is_predicted ?? '1') === '0'
  const remote = looksRemote(r.title, r.description)
  return {
    job: {
      source: 'adzuna',
      sourceId: String(r.id),
      title: r.title.replace(/<[^>]+>/g, '').trim() || 'Unknown',
      company: r.company?.display_name?.trim() || 'Unknown',
      location: r.location?.display_name,
      remoteType: remote ? 'remote' : undefined,
      salaryMin: stated ? r.salary_min || undefined : undefined,
      salaryMax: stated ? r.salary_max || undefined : undefined,
      salaryCurrency: stated ? 'USD' : undefined,
      description: r.description || '',
      url: r.redirect_url,
      tags: r.category?.label ? [r.category.label] : [],
    },
    postedAt: toIso(r.created),
    locations: r.location?.display_name ? [r.location.display_name] : [],
    remote,
    // The query asks for full_time=1.
    fullTime: true,
    usOnly: true,
  }
}

export const adzunaAdapter = aggregator({
  name: 'adzuna',
  // Adzuna indexes listings from other boards and keeps their original dates, so a listing can
  // show up a little after its created time.
  overlapHours: 24,

  async pull(params: SearchParams, ctx: PullContext): Promise<PullResult> {
    const config = useRuntimeConfig()
    if (!config.adzunaAppId || !config.adzunaApiKey) {
      throw new SourceUnavailable('adzuna', 'Adzuna credentials are not configured (NUXT_ADZUNA_APP_ID, NUXT_ADZUNA_API_KEY)')
    }

    const results: PullResult[] = []
    for (const keyword of params.keywords) {
      const scope = keyword.trim().toLowerCase()
      const start = windowStart(ctx, scope)
      const days = Math.min(14, Math.max(1, Math.ceil((Date.now() - start.getTime()) / 86400000)))
      results.push(await scoped(scope, async () => {
        const { items, result } = await pagedPull<AdzunaResult>({
          scope,
          start,
          firstPage: 1,
          maxPages: 60,
          stop: 'last-older',
          timeOf: r => toTime(r.created),
          idOf: r => String(r.id),
          fetchPage: async (page) => {
            const query = new URLSearchParams({
              app_id: config.adzunaAppId,
              app_key: config.adzunaApiKey,
              title_only: keyword,
              results_per_page: String(PER_PAGE),
              sort_by: 'date',
              max_days_old: String(days),
              full_time: '1',
            })
            if (params.remoteOnly) query.set('what', 'remote')
            try {
              const data = await fetchJson<{ results?: AdzunaResult[]; count?: number }>(
                `https://api.adzuna.com/v1/api/jobs/us/search/${page}?${query}`,
                { minIntervalMs: 2600, cache: true },
              )
              const list = data.results ?? []
              return { items: list, last: list.length < PER_PAGE || page * PER_PAGE >= (data.count ?? 0) }
            }
            catch (e) {
              if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
                throw new SourceUnavailable('adzuna', `Adzuna rejected the credentials (HTTP ${e.status})`)
              }
              throw e
            }
          },
        })
        return { listings: items.map(toListing), result }
      }))
    }
    return mergeResults(results)
  },
})

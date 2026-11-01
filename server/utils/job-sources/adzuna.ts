import type { JobSourceAdapter, NormalizedJob, SearchParams } from './types'
import { SourceUnavailable } from './types'
import { isSoftwareRoleTitle, looksRemote, matchesAnyTerm, payBelow, titleMatchesKeywords } from './filters'
import { fetchJson, HttpError } from './http'

// Adzuna search API: https://developer.adzuna.com/docs/search
//
// Two bugs made this source return nothing in production:
// - The February build sent `content_type=application/json`. Adzuna does not know that
//   parameter and answers 400 with an HTML error page.
// - The rewrite after it put every keyword in `what` joined by "OR". `what` requires every
//   word, including the literal word "OR", so it matched zero listings.
// Now: one request per keyword with `title_only` (all its words must be in the title),
// `what=remote` when the config is remote-only, newest first. Excluded terms and the pay
// floor are applied in code on the title and the stated salary, because `what_exclude`
// searches the whole description ("entry level" would drop every listing that says "level").

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

export const adzunaAdapter: JobSourceAdapter = {
  name: 'adzuna',

  async search(params: SearchParams): Promise<NormalizedJob[]> {
    const config = useRuntimeConfig()
    if (!config.adzunaAppId || !config.adzunaApiKey) {
      throw new SourceUnavailable('adzuna', 'Adzuna credentials are not configured (NUXT_ADZUNA_APP_ID, NUXT_ADZUNA_API_KEY)')
    }

    const byId = new Map<string, AdzunaResult>()
    for (const keyword of params.keywords) {
      const query = new URLSearchParams({
        app_id: config.adzunaAppId,
        app_key: config.adzunaApiKey,
        title_only: keyword,
        results_per_page: '50',
        sort_by: 'date',
        max_days_old: '14',
        full_time: '1',
      })
      if (params.remoteOnly) query.set('what', 'remote')
      try {
        const data = await fetchJson<{ results?: AdzunaResult[] }>(`https://api.adzuna.com/v1/api/jobs/us/search/1?${query}`)
        for (const r of data.results ?? []) byId.set(String(r.id), r)
      }
      catch (e) {
        if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
          throw new SourceUnavailable('adzuna', `Adzuna rejected the credentials (HTTP ${e.status})`)
        }
        throw e
      }
    }

    return [...byId.values()]
      .filter(r => titleMatchesKeywords(r.title, params.keywords))
      .filter(r => isSoftwareRoleTitle(r.title))
      .filter(r => !matchesAnyTerm(r.title, params.excludedKeywords))
      .filter(r => !params.remoteOnly || looksRemote(r.title, r.description))
      .map((r) => {
        // Adzuna fills salary_min/max with its own prediction when the employer gave none.
        // A predicted number is Adzuna's guess, not the employer's, so it is never stored.
        const stated = String(r.salary_is_predicted ?? '1') === '0'
        return {
          source: 'adzuna',
          sourceId: String(r.id),
          title: r.title.replace(/<[^>]+>/g, '').trim() || 'Unknown',
          company: r.company?.display_name?.trim() || 'Unknown',
          location: r.location?.display_name,
          remoteType: looksRemote(r.title, r.description) ? 'remote' : undefined,
          salaryMin: stated ? r.salary_min || undefined : undefined,
          salaryMax: stated ? r.salary_max || undefined : undefined,
          salaryCurrency: stated ? 'USD' : undefined,
          description: r.description || '',
          url: r.redirect_url,
          tags: r.category?.label ? [r.category.label] : [],
        } satisfies NormalizedJob
      })
      .filter(j => !payBelow(params.salaryMin, j.salaryMin, j.salaryMax))
  },
}

import type { JobSourceAdapter, NormalizedJob, PullContext, PullResult, SearchParams } from './types'
import type { Board } from './board-discovery'
import { type BoardPosting, pullBoards, searchBoards } from './board-runner'
import { looksRemote, sanitizeHtml } from './filters'
import { fetchJson } from './http'

// Gem's public job board API (no key): api.gem.com/job_board/v0/<board>/job_posts/, the same
// shape as Greenhouse's. No curated list; boards come from apply links (jobs.gem.com/<board>/<id>).
// The posting pages are script-only, so the listing carries the description and enrichment reads
// it from the listing. updated_at is the change time.

interface GemPost {
  id: string
  title: string
  absolute_url?: string
  content?: string
  location?: { name?: string } | null
  location_type?: string | null
  employment_type?: string | null
  departments?: Array<{ name?: string }>
  first_published_at?: string | null
  updated_at?: string | null
}

async function fetchBoard(board: Board): Promise<BoardPosting[]> {
  const data = await fetchJson<GemPost[]>(`https://api.gem.com/job_board/v0/${encodeURIComponent(board.token)}/job_posts/`, { cache: true })
  return (Array.isArray(data) ? data : []).filter(p => p.id && p.title).map((p) => {
    const location = p.location?.name?.trim() || undefined
    const remote = /remote/i.test(p.location_type ?? '') || looksRemote(location, p.title)
    return {
      job: {
        source: 'gem',
        sourceId: `${board.token}:${p.id}`,
        title: p.title.trim(),
        company: board.company,
        location,
        remoteType: remote ? 'remote' : /hybrid/i.test(p.location_type ?? '') ? 'hybrid' : /onsite|in_office/i.test(p.location_type ?? '') ? 'onsite' : undefined,
        description: sanitizeHtml(p.content ?? ''),
        url: p.absolute_url || `https://jobs.gem.com/${board.token}/${p.id}`,
        applyUrl: p.absolute_url,
        tags: (p.departments ?? []).map(d => d.name).filter((n): n is string => !!n),
        atsMeta: { board: board.token, postingId: p.id },
      },
      publishedAt: p.first_published_at ?? p.updated_at ?? null,
      changedAt: p.updated_at ?? p.first_published_at ?? null,
      locations: location ? [location] : [],
      remote,
      fullTime: !/part|intern|temporary|contract/i.test(p.employment_type ?? ''),
    }
  })
}

export const gemAdapter: JobSourceAdapter = {
  name: 'gem',
  overlapHours: 2,
  search: (params: SearchParams): Promise<NormalizedJob[]> => searchBoards('gem', params, fetchBoard),
  pull: (_params: SearchParams, ctx: PullContext): Promise<PullResult> => pullBoards('gem', ctx, fetchBoard),
}

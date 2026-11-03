import type { JobSourceAdapter, NormalizedJob, PullContext, PullResult, SearchParams } from './types'
import type { Board } from './board-discovery'
import { type BoardPosting, pullBoards, searchBoards } from './board-runner'
import { looksRemote, sanitizeHtml } from './filters'
import { fetchJson } from './http'

// Workable's public per-company job widget (no key): apply.workable.com/api/v1/widget/accounts/<token>.
// No curated list; boards come from apply links (apply.workable.com/<token>/j/<shortcode>).
// The posting pages are script-only, so the listing carries the description, and enrichment reads
// it from the listing. Dates are days only, so there is no change time: every pull reads the whole
// board and dedupe decides what is new.

interface WorkableJob {
  title: string
  shortcode: string
  employment_type?: string
  telecommuting?: boolean
  department?: string
  url?: string
  application_url?: string
  published_on?: string
  created_at?: string
  country?: string
  city?: string
  state?: string
  locations?: Array<{ country?: string; city?: string; region?: string }>
  description?: string
}

async function fetchBoard(board: Board): Promise<BoardPosting[]> {
  const data = await fetchJson<{ name?: string; jobs?: WorkableJob[] }>(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(board.token)}?details=true`, { cache: true })
  return (data.jobs ?? []).filter(j => j.shortcode && j.title).map((j) => {
    const place = [j.city, j.state, j.country].filter(Boolean).join(', ')
    const others = (j.locations ?? []).map(l => [l.city, l.region, l.country].filter(Boolean).join(', ')).filter(Boolean)
    const remote = j.telecommuting === true || looksRemote(j.title, place)
    return {
      job: {
        source: 'workable',
        sourceId: `${board.token}:${j.shortcode}`,
        title: j.title.trim(),
        company: data.name?.trim() || board.company,
        location: place || others[0] || undefined,
        remoteType: remote ? 'remote' : undefined,
        description: sanitizeHtml(j.description ?? ''),
        url: `https://apply.workable.com/${board.token}/j/${j.shortcode}/`,
        applyUrl: j.application_url || `https://apply.workable.com/${board.token}/j/${j.shortcode}/apply/`,
        tags: j.department ? [j.department] : [],
        atsType: 'workable',
        atsMeta: { board: board.token, postingId: j.shortcode },
      },
      publishedAt: j.published_on || j.created_at || null,
      changedAt: null,
      locations: [place, ...others].filter(Boolean),
      remote,
      fullTime: !/part|contract|temporary|intern/i.test(j.employment_type ?? ''),
    }
  })
}

export const workableAdapter: JobSourceAdapter = {
  name: 'workable',
  search: (params: SearchParams): Promise<NormalizedJob[]> => searchBoards('workable', params, fetchBoard),
  pull: (_params: SearchParams, ctx: PullContext): Promise<PullResult> => pullBoards('workable', ctx, fetchBoard),
}

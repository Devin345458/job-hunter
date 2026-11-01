import type { JobSourceAdapter, NormalizedJob, SearchParams } from './types'
import { searchBoards } from './board-runner'
import { looksRemote, sanitizeHtml } from './filters'
import { fetchJson } from './http'

export interface LeverPosting {
  id: string
  text: string
  hostedUrl: string
  applyUrl: string
  createdAt?: number
  workplaceType?: 'remote' | 'hybrid' | 'onsite' | 'unspecified' | null
  country?: string | null
  categories?: { location?: string; allLocations?: string[]; commitment?: string; team?: string; department?: string }
  description?: string
  lists?: Array<{ text: string; content: string }>
  additional?: string
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string } | null
  salaryDescription?: string | null
}

export function leverHtml(p: LeverPosting): string {
  const parts = [p.description ?? '']
  for (const list of p.lists ?? []) parts.push(`<h3>${list.text}</h3><ul>${list.content}</ul>`)
  if (p.salaryDescription) parts.push(p.salaryDescription)
  if (p.additional) parts.push(p.additional)
  return sanitizeHtml(parts.join('\n'))
}

// Public Lever postings API. The list already carries the full description.
export const leverAdapter: JobSourceAdapter = {
  name: 'lever',

  search(params: SearchParams): Promise<NormalizedJob[]> {
    return searchBoards('lever', params, async (board) => {
      const data = await fetchJson<LeverPosting[]>(`https://api.lever.co/v0/postings/${encodeURIComponent(board.token)}?mode=json`)
      return (Array.isArray(data) ? data : []).map((p) => {
        const location = p.categories?.location?.trim() || undefined
        const remote = p.workplaceType === 'remote' || looksRemote(location, p.text)
        const yearly = p.salaryRange && /year|annual/i.test(p.salaryRange.interval ?? '')
        return {
          job: {
            source: 'lever',
            sourceId: `${board.token}:${p.id}`,
            title: p.text.trim(),
            company: board.company,
            location,
            remoteType: remote ? 'remote' : p.workplaceType === 'hybrid' ? 'hybrid' : p.workplaceType === 'onsite' ? 'onsite' : undefined,
            salaryMin: yearly ? p.salaryRange?.min : undefined,
            salaryMax: yearly ? p.salaryRange?.max : undefined,
            salaryCurrency: yearly ? p.salaryRange?.currency : undefined,
            description: leverHtml(p),
            url: p.hostedUrl,
            applyUrl: p.applyUrl,
            tags: [p.categories?.team, p.categories?.department].filter((t): t is string => !!t),
            atsType: 'lever',
            atsMeta: { company: board.token, postingId: p.id, salaryRange: p.salaryRange ?? null },
          },
          publishedAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
          locations: [...(p.categories?.allLocations ?? []), location, p.country === 'US' ? 'United States' : null].filter((l): l is string => !!l),
          remote,
          fullTime: !/intern|part[\s-]?time|temporary|seasonal/i.test(p.categories?.commitment ?? ''),
        }
      })
    })
  },
}

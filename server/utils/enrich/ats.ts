import type { AtsType } from '#shared/types/pipeline'
import { ATS_BOARDS, type AtsBoard, type BoardAts, greenhouseApplyUrl } from '../job-sources/ats-boards'
import { normalizeCompany } from '../job-sources/filters'
import { fetchJson, HttpError } from '../job-sources/http'

// Which applicant tracking system a URL belongs to, and how to reach a posting's data on the
// three ATS platforms with public APIs (Greenhouse, Lever, Ashby).

const HOST_RULES: Array<[RegExp, AtsType]> = [
  [/(^|\.)greenhouse\.io$/, 'greenhouse'],
  [/(^|\.)lever\.co$/, 'lever'],
  [/(^|\.)ashbyhq\.com$/, 'ashby'],
  [/(^|\.)workable\.com$/, 'workable'],
  [/(^|\.)smartrecruiters\.com$/, 'smartrecruiters'],
  [/(^|\.)recruitee\.com$/, 'recruitee'],
  [/(^|\.)bamboohr\.com$/, 'bamboohr'],
  [/(^|\.)jobvite\.com$/, 'jobvite'],
  [/(^|\.)myworkdayjobs\.com$|(^|\.)myworkdaysite\.com$|(^|\.)workday\.com$/, 'workday'],
  [/(^|\.)icims\.com$/, 'icims'],
  [/(^|\.)taleo\.net$/, 'taleo'],
  [/(^|\.)successfactors\.(com|eu)$|^jobs\.sap\.com$|(^|\.)sapsf\.com$/, 'successfactors'],
]

/** ATS type for a URL by its host. gh_jid on a company careers page means an embedded Greenhouse board. */
export function detectAts(url: string | null | undefined): AtsType {
  if (!url) return 'unknown'
  let parsed: URL
  try {
    parsed = new URL(url)
  }
  catch {
    return 'unknown'
  }
  const host = parsed.hostname.toLowerCase()
  for (const [pattern, ats] of HOST_RULES) if (pattern.test(host)) return ats
  if (parsed.searchParams.has('gh_jid')) return 'greenhouse'
  if (parsed.searchParams.has('lever-source') || parsed.searchParams.has('lever-origin')) return 'lever'
  return 'other'
}

export interface AtsPostingRef {
  ats: BoardAts
  /** Board token (Greenhouse), company (Lever), or org (Ashby). */
  board: string
  postingId: string
}

/** Board and posting id from a Greenhouse, Lever, or Ashby posting or form URL. */
export function parseAtsUrl(url: string): AtsPostingRef | null {
  let u: URL
  try {
    u = new URL(url.replace(/&amp;/g, '&'))
  }
  catch {
    return null
  }
  const host = u.hostname.toLowerCase()
  const parts = u.pathname.split('/').filter(Boolean)
  if (/greenhouse\.io$/.test(host)) {
    if (parts[0] === 'embed' && u.searchParams.get('for') && u.searchParams.get('token')) {
      return { ats: 'greenhouse', board: u.searchParams.get('for')!, postingId: u.searchParams.get('token')! }
    }
    const i = parts.indexOf('jobs')
    if (i > 0 && parts[i + 1] && /^\d+$/.test(parts[i + 1]!)) return { ats: 'greenhouse', board: parts[0]!, postingId: parts[i + 1]! }
    return null
  }
  if (host === 'jobs.lever.co' && parts.length >= 2 && /^[0-9a-f-]{36}$/i.test(parts[1]!)) {
    return { ats: 'lever', board: parts[0]!, postingId: parts[1]! }
  }
  if (host === 'jobs.ashbyhq.com' && parts.length >= 2 && /^[0-9a-f-]{36}$/i.test(parts[1]!)) {
    return { ats: 'ashby', board: decodeURIComponent(parts[0]!), postingId: parts[1]! }
  }
  return null
}

const ATS_LINK = /https?:\/\/(?:[a-z0-9-]+\.)*(?:greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|recruitee\.com|bamboohr\.com|jobvite\.com|myworkdayjobs\.com|icims\.com|taleo\.net|successfactors\.com)\/[^\s"'<>)]+/gi

/** Employer ATS links that appear inside a listing's HTML, best first (parseable Greenhouse, Lever, Ashby links lead). */
export function findAtsLinks(html: string | null | undefined): string[] {
  if (!html) return []
  const links = [...new Set((html.match(ATS_LINK) ?? []).map(l => l.replace(/&amp;/g, '&').replace(/[.,;]+$/, '')))]
  return links.sort((a, b) => Number(!!parseAtsUrl(b)) - Number(!!parseAtsUrl(a)))
}

// ── Board lookups ───────────────────────────────────────────

export interface BoardListing {
  ref: AtsPostingRef
  title: string
  location: string | null
  postingUrl: string
  applyUrl: string
  /** Lever and Ashby lists carry the full posting; Greenhouse needs a detail call. */
  raw: any
}

async function listBoard(ats: BoardAts, board: string): Promise<BoardListing[]> {
  if (ats === 'greenhouse') {
    const d = await fetchJson<{ jobs: any[] }>(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs`)
    return (d.jobs ?? []).map(j => ({
      ref: { ats, board, postingId: String(j.id) },
      title: j.title,
      location: j.location?.name ?? null,
      postingUrl: j.absolute_url,
      applyUrl: greenhouseApplyUrl(board, j.id),
      raw: j,
    }))
  }
  if (ats === 'lever') {
    const d = await fetchJson<any[]>(`https://api.lever.co/v0/postings/${encodeURIComponent(board)}?mode=json`)
    return (Array.isArray(d) ? d : []).map(p => ({
      ref: { ats, board, postingId: p.id },
      title: p.text,
      location: p.categories?.location ?? null,
      postingUrl: p.hostedUrl,
      applyUrl: p.applyUrl,
      raw: p,
    }))
  }
  const d = await fetchJson<{ jobs: any[] }>(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}?includeCompensation=true`)
  return (d.jobs ?? []).filter(j => j.isListed !== false).map(j => ({
    ref: { ats, board, postingId: j.id },
    title: j.title,
    location: j.location ?? null,
    postingUrl: j.jobUrl,
    applyUrl: j.applyUrl,
    raw: j,
  }))
}

/** Per-run cache of board listings, so twenty Remotive jobs from one company cost one request. */
export class BoardCache {
  private boards = new Map<string, Promise<BoardListing[] | null>>()

  list(ats: BoardAts, board: string): Promise<BoardListing[] | null> {
    const key = `${ats}:${board.toLowerCase()}`
    let hit = this.boards.get(key)
    if (!hit) {
      hit = listBoard(ats, board).catch((e) => {
        if (e instanceof HttpError && e.status === 404) return null
        throw e
      })
      this.boards.set(key, hit)
    }
    return hit
  }
}

function titleTokens(title: string): Set<string> {
  return new Set(title.toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\bsr\b\.?/g, 'senior')
    .replace(/[^a-z0-9+#]+/g, ' ')
    .split(' ')
    .filter(t => t && !['the', 'a', 'an', 'and', 'of', 'remote', 'us', 'usa'].includes(t)))
}

/** Token overlap between two titles, 0 to 1. */
export function titleSimilarity(a: string, b: string): number {
  const ta = titleTokens(a)
  const tb = titleTokens(b)
  if (!ta.size || !tb.size) return 0
  let common = 0
  for (const t of ta) if (tb.has(t)) common++
  return common / (ta.size + tb.size - common)
}

/** Board slugs worth trying for a company name: the curated board first, then common slug shapes. */
export function boardCandidates(company: string): Array<{ ats: BoardAts; board: string }> {
  const norm = normalizeCompany(company)
  if (!norm || norm === 'unknown') return []
  const curated = ATS_BOARDS.filter((b: AtsBoard) => normalizeCompany(b.company) === norm || b.token.toLowerCase() === norm)
  if (curated.length) return curated.map(b => ({ ats: b.ats, board: b.token }))
  const words = company.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
  const slugs = [...new Set([norm, words.join('-'), words.join('')])].filter(s => s.length >= 3)
  return slugs.flatMap(board => (['greenhouse', 'lever', 'ashby'] as BoardAts[]).map(ats => ({ ats, board })))
}

/**
 * Finds a listing from an aggregator on the employer's own Greenhouse, Lever, or Ashby board,
 * by company and title. Returns null unless one posting's title is a close match.
 */
export async function findOnEmployerBoard(cache: BoardCache, company: string, title: string): Promise<BoardListing | null> {
  let best: { listing: BoardListing; score: number } | null = null
  for (const { ats, board } of boardCandidates(company)) {
    const listings = await cache.list(ats, board).catch(() => null)
    if (!listings?.length) continue
    for (const listing of listings) {
      const score = titleSimilarity(title, listing.title)
      if (!best || score > best.score) best = { listing, score }
    }
    if (best && best.score >= 0.99) break
  }
  return best && best.score >= 0.75 ? best.listing : null
}

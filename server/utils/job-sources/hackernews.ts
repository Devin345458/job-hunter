import type { PullContext, PullResult, RawListing, SearchParams } from './types'
import { decodeEntities, isEngineeringTitle, looksRemote, sanitizeHtml } from './filters'
import { fetchJson } from './http'
import { aggregator, mergeResults, scoped, windowStart } from './paging'
import { parseListedSalary } from './remotive'

// Hacker News, two parts (scopes):
// - whoishiring: top-level comments on the monthly "Ask HN: Who is hiring?" threads, read through
//   the Algolia HN API with a server-side created_at filter, so an incremental pull asks only for
//   comments since the watermark. Most posts start with a pipe-separated line
//   ("Company | Role | Location | REMOTE (US) | Full-time | $150k-$200k"), parsed without Claude.
//   Posts without that line are skipped. Algolia allows 10,000 requests an hour per IP.
// - jobstories: Y Combinator company job posts from the official HN Firebase API (no rate limit).
//   Titles only, such as "Acme (YC W21) Is Hiring a Senior Engineer".

interface AlgoliaHit {
  objectID: string
  comment_text?: string
  created_at?: string
  created_at_i?: number
  parent_id?: number
  story_id?: number
  title?: string
}

const ALGOLIA = 'https://hn.algolia.com/api/v1'

function plain(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

const FULL_TIME = /\b(full[\s-]?time|ft)\b/i
const NOT_FULL_TIME = /\b(part[\s-]?time|contract(or)?|intern(ship)?|freelance)\b/i

/** One "Who is hiring" comment as a listing, or null when it has no pipe-separated first line. */
export function parseHiringComment(hit: AlgoliaHit): RawListing | null {
  const html = hit.comment_text ?? ''
  const firstLine = plain(html.split(/<p>/i)[0] ?? '')
  const parts = firstLine.split('|').map(s => s.trim()).filter(Boolean)
  if (parts.length < 2) return null
  const company = parts[0]!.replace(/\s*\(.*?\)\s*$/, '').trim() || parts[0]!
  const rest = parts.slice(1)
  const roleParts = rest.filter(p => isEngineeringTitle(p))
  const title = (roleParts.length ? roleParts.join(', ') : rest[0]!).slice(0, 300)
  const other = rest.filter(p => !roleParts.includes(p))
  const remote = rest.some(p => /\bremote\b/i.test(p))
  const salary = parseListedSalary(rest.find(p => /\$\s?\d/.test(p)) ?? null)
  const fullTime = !(rest.some(p => NOT_FULL_TIME.test(p)) && !rest.some(p => FULL_TIME.test(p)))
  const locations = other.filter(p => !/\$\s?\d/.test(p) && !FULL_TIME.test(p) && !NOT_FULL_TIME.test(p) && !/^https?:\/\//i.test(p))
  return {
    job: {
      source: 'hackernews',
      sourceId: hit.objectID,
      title,
      company,
      location: locations.join('; ').slice(0, 200) || undefined,
      remoteType: remote ? 'remote' : undefined,
      salaryMin: salary?.min,
      salaryMax: salary?.max,
      salaryCurrency: salary ? 'USD' : undefined,
      description: sanitizeHtml(html),
      url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
      tags: ['Who is hiring'],
    },
    postedAt: hit.created_at ?? null,
    locations,
    remote,
    fullTime,
  }
}

/** A Y Combinator job post title as company and role. */
export function parseJobStory(item: { id: number; title?: string; url?: string; time?: number; text?: string }): RawListing | null {
  const raw = decodeEntities(item.title ?? '').trim()
  if (!raw) return null
  const m = raw.match(/^(.*?)\s*(\(YC [A-Z]\d{2}\))?\s+(?:is\s+)?hiring\s*(?:an?\s+)?(.*)$/i)
  const company = (m?.[1] || raw.split(/\s+\(YC/)[0] || raw).trim()
  const role = (m?.[3] || raw).replace(/^[:\s-]+/, '').trim() || raw
  const remote = looksRemote(raw)
  const inPlace = role.match(/\bin\s+([A-Z][\w .,'-]+)$/)?.[1]
  return {
    job: {
      source: 'hackernews',
      sourceId: String(item.id),
      title: role.slice(0, 300),
      company,
      location: inPlace,
      remoteType: remote ? 'remote' : undefined,
      description: item.text ? sanitizeHtml(item.text) : undefined,
      url: item.url || `https://news.ycombinator.com/item?id=${item.id}`,
      tags: ['YC job post'],
    },
    postedAt: item.time ? new Date(item.time * 1000).toISOString() : null,
    locations: inPlace ? [inPlace] : [],
    remote,
    fullTime: !NOT_FULL_TIME.test(raw),
  }
}

async function pullWhoIsHiring(ctx: PullContext) {
  const start = windowStart(ctx, 'whoishiring')
  const startSec = Math.floor(start.getTime() / 1000)
  const stories = await fetchJson<{ hits: AlgoliaHit[] }>(`${ALGOLIA}/search_by_date?tags=story,author_whoishiring&hitsPerPage=8`, { cache: true })
  // A thread keeps collecting posts through its month, so read every thread from the last 45 days.
  const threads = stories.hits
    .filter(h => /^Ask HN: Who is hiring\?/i.test(h.title ?? ''))
    .filter(h => (h.created_at_i ?? 0) * 1000 > start.getTime() - 45 * 86400000)
  let requests = 1
  const listings: RawListing[] = []
  for (const thread of threads) {
    for (let page = 0; page < 20; page++) {
      const query = new URLSearchParams({ tags: `comment,story_${thread.objectID}`, hitsPerPage: '1000', page: String(page), numericFilters: `created_at_i>=${startSec}` })
      const data = await fetchJson<{ hits: AlgoliaHit[]; nbPages?: number }>(`${ALGOLIA}/search_by_date?${query}`, { cache: true, minIntervalMs: 500 })
      requests++
      for (const hit of data.hits ?? []) {
        if (String(hit.parent_id) !== thread.objectID) continue
        const listing = parseHiringComment(hit)
        if (listing) listings.push(listing)
      }
      if (page + 1 >= (data.nbPages ?? 0)) break
    }
  }
  return { listings, result: { scope: 'whoishiring', ok: true, found: listings.length, requests, complete: true } }
}

async function pullJobStories(ctx: PullContext) {
  const start = windowStart(ctx, 'jobstories').getTime()
  const ids = await fetchJson<number[]>('https://hacker-news.firebaseio.com/v0/jobstories.json', { cache: true })
  const listings: RawListing[] = []
  let requests = 1
  for (const id of (Array.isArray(ids) ? ids : []).slice(0, 200)) {
    const item = await fetchJson<{ id: number; title?: string; url?: string; time?: number; text?: string; dead?: boolean; deleted?: boolean } | null>(
      `https://hacker-news.firebaseio.com/v0/item/${id}.json`,
      { cache: true, minIntervalMs: 100 },
    )
    requests++
    if (!item || item.dead || item.deleted || (item.time ?? 0) * 1000 < start) continue
    const listing = parseJobStory(item)
    if (listing) listings.push(listing)
  }
  return { listings, result: { scope: 'jobstories', ok: true, found: listings.length, requests, complete: true } }
}

export const hackernewsAdapter = aggregator({
  name: 'hackernews',
  overlapHours: 1,
  async pull(_params: SearchParams, ctx: PullContext): Promise<PullResult> {
    return mergeResults([
      await scoped('whoishiring', () => pullWhoIsHiring(ctx)),
      await scoped('jobstories', () => pullJobStories(ctx)),
    ])
  },
})

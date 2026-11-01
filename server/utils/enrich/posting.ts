import type { InferSelectModel } from 'drizzle-orm'
import type { AtsType } from '#shared/types/pipeline'
import type { jobs } from '../../db/schema'
import { htmlToText, parseJson } from '../review'
import { greenhouseApplyUrl } from '../job-sources/ats-boards'
import { decodeEntities, sanitizeHtml } from '../job-sources/filters'
import { fetchJson, fetchText, HttpError } from '../job-sources/http'
import { leverHtml } from '../job-sources/lever'
import { type AtsPostingRef, type BoardCache, detectAts, findAtsLinks, findOnEmployerBoard, parseAtsUrl } from './ats'

type JobRow = InferSelectModel<typeof jobs>

export interface ResolvedPosting {
  /** Full posting as plain text, with any structured pay the employer published appended. */
  postingText: string | null
  /** Posting HTML, used to fill jobs.description when the listing had none. */
  descriptionHtml: string | null
  applyUrl: string | null
  atsType: AtsType
  atsMeta: Record<string, unknown> | null
  /** How the apply URL was found, for the run log and the job page. */
  via: 'source_board' | 'listing_link' | 'employer_board_lookup' | 'employer_page' | 'none'
  /** True when the employer's board says the posting no longer exists. */
  closed: boolean
  notes: string[]
}

const AGGREGATOR_HOSTS = /(^|\.)(remotive\.com|adzuna\.com|himalayas\.app|remoteok\.com|jobicy\.com|arbeitnow\.com|google\.com)$/i
const MAX_TEXT = 40000

function usd(n: number) {
  return `$${Math.round(n).toLocaleString('en-US')}`
}

function money(n: number, currency: string | null | undefined) {
  return !currency || currency === 'USD' ? usd(n) : `${Math.round(n).toLocaleString('en-US')} ${currency}`
}

interface AtsDetail {
  html: string
  postingUrl: string | null
  applyUrl: string
  payLines: string[]
  meta: Record<string, unknown>
}

async function fetchAtsDetail(ref: AtsPostingRef, cache: BoardCache, preloaded?: any): Promise<AtsDetail> {
  if (ref.ats === 'greenhouse') {
    const d = await fetchJson<any>(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(ref.board)}/jobs/${encodeURIComponent(ref.postingId)}?pay_transparency=true`)
    const payLines = (d.pay_input_ranges ?? [])
      .filter((r: any) => r.min_cents != null || r.max_cents != null)
      .map((r: any) => {
        const min = r.min_cents != null ? money(r.min_cents / 100, r.currency_type) : null
        const max = r.max_cents != null ? money(r.max_cents / 100, r.currency_type) : null
        return `Pay range published on the employer's job board${r.title ? ` (${r.title})` : ''}: ${[min, max].filter(Boolean).join(' to ')}${r.currency_type ? ` ${r.currency_type}` : ''}`
      })
    return {
      html: sanitizeHtml(decodeEntities(d.content ?? '')),
      postingUrl: d.absolute_url ?? null,
      applyUrl: greenhouseApplyUrl(ref.board, ref.postingId),
      payLines,
      meta: { boardToken: ref.board, postingId: Number(ref.postingId) || ref.postingId, payRanges: d.pay_input_ranges ?? [] },
    }
  }
  if (ref.ats === 'lever') {
    const p = preloaded ?? await fetchJson<any>(`https://api.lever.co/v0/postings/${encodeURIComponent(ref.board)}/${encodeURIComponent(ref.postingId)}`)
    const range = p.salaryRange
    const payLines = range && (range.min || range.max)
      ? [`Pay range published on the employer's job board: ${[range.min, range.max].filter(Boolean).map((n: number) => money(n, range.currency)).join(' to ')}${range.currency ? ` ${range.currency}` : ''}${range.interval ? ` (${String(range.interval).replace(/-/g, ' ')})` : ''}`]
      : []
    return {
      html: leverHtml(p),
      postingUrl: p.hostedUrl ?? null,
      applyUrl: p.applyUrl,
      payLines,
      meta: { company: ref.board, postingId: ref.postingId, salaryRange: range ?? null },
    }
  }
  const job = preloaded ?? (await cache.list('ashby', ref.board))?.find(l => l.ref.postingId === ref.postingId)?.raw
  if (!job) throw new HttpError(404, `https://jobs.ashbyhq.com/${ref.board}/${ref.postingId}`, 'posting not on the board')
  const summary = job.compensation?.compensationTierSummary || job.compensation?.scrapeableCompensationSalarySummary || null
  return {
    html: sanitizeHtml(job.descriptionHtml ?? ''),
    postingUrl: job.jobUrl ?? null,
    applyUrl: job.applyUrl,
    payLines: summary ? [`Compensation published on the employer's job board: ${summary}`] : [],
    meta: { board: ref.board, postingId: ref.postingId, compensationSummary: summary },
  }
}

/** JobPosting structured data (schema.org) that many career pages embed. */
function jsonLdPosting(html: string): { description?: string; payLine?: string } | null {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1]!.trim())
      const items = Array.isArray(data) ? data : data['@graph'] ?? [data]
      const posting = items.find((i: any) => i?.['@type'] === 'JobPosting')
      if (!posting) continue
      const v = posting.baseSalary?.value
      const min = v?.minValue ?? (typeof v?.value === 'number' ? v.value : null)
      const max = v?.maxValue ?? null
      const payLine = min || max
        ? `Base salary in the posting's structured data: ${[min, max].filter(Boolean).map((n: number) => money(Number(n), posting.baseSalary?.currency)).join(' to ')}${v?.unitText ? ` per ${String(v.unitText).toLowerCase()}` : ''}`
        : undefined
      return { description: typeof posting.description === 'string' ? posting.description : undefined, payLine }
    }
    catch {
      // malformed structured data: ignore
    }
  }
  return null
}

function composeText(html: string | null | undefined, payLines: string[]): string | null {
  const body = htmlToText(html ?? '') ?? ''
  const pay = payLines.length ? `\n\nPay information\n${payLines.map(l => `- ${l}`).join('\n')}` : ''
  const text = `${body}${pay}`.trim()
  return text ? text.slice(0, MAX_TEXT) : null
}

function refFromSource(job: JobRow): AtsPostingRef | null {
  const meta = parseJson<Record<string, any>>(job.atsMeta, {})
  if (job.source === 'greenhouse' && meta.boardToken && meta.postingId) return { ats: 'greenhouse', board: String(meta.boardToken), postingId: String(meta.postingId) }
  if (job.source === 'lever' && meta.company && meta.postingId) return { ats: 'lever', board: String(meta.company), postingId: String(meta.postingId) }
  if (job.source === 'ashby' && meta.board && meta.postingId) return { ats: 'ashby', board: String(meta.board), postingId: String(meta.postingId) }
  return null
}

/**
 * Finds the full posting and the employer's application form for one job, without Claude:
 * 1. Listings from the Greenhouse, Lever, and Ashby adapters already point at the employer board.
 * 2. Otherwise a Greenhouse, Lever, or Ashby link inside the listing.
 * 3. Otherwise the same title on the company's own board (Remotive and Adzuna hide the employer link).
 * 4. Otherwise the listing URL itself when it is an employer page rather than an aggregator.
 * The listing's own description is the fallback text.
 */
export async function resolvePosting(job: JobRow, cache: BoardCache): Promise<ResolvedPosting> {
  const notes: string[] = []
  const meta = parseJson<Record<string, any>>(job.atsMeta, {})
  const listedPay: string[] = meta.listedSalary ? [`Salary listed on ${job.source}: ${meta.listedSalary}`] : []

  let ref: AtsPostingRef | null = refFromSource(job)
  let via: ResolvedPosting['via'] = ref ? 'source_board' : 'none'
  let preloaded: any
  let otherAtsLink: string | null = null

  if (!ref) {
    const links = findAtsLinks(job.description)
    const parseable = links.map(parseAtsUrl).find(Boolean) ?? null
    if (parseable) {
      ref = parseable
      via = 'listing_link'
    }
    else if (links[0]) {
      otherAtsLink = links[0]
    }
  }

  if (!ref && !otherAtsLink) {
    try {
      const listing = await findOnEmployerBoard(cache, job.company, job.title)
      if (listing) {
        ref = listing.ref
        via = 'employer_board_lookup'
        if (listing.ref.ats !== 'greenhouse') preloaded = listing.raw
        notes.push(`Matched "${listing.title}" on ${job.company}'s ${listing.ref.ats} board`)
      }
    }
    catch (e: any) {
      notes.push(`Employer board lookup failed: ${e?.message || e}`)
    }
  }

  if (ref) {
    try {
      const detail = await fetchAtsDetail(ref, cache, preloaded)
      return {
        postingText: composeText(detail.html || job.description, [...detail.payLines, ...listedPay]),
        descriptionHtml: detail.html || null,
        applyUrl: detail.applyUrl,
        atsType: ref.ats,
        atsMeta: { ...meta, ...detail.meta, postingUrl: detail.postingUrl, resolvedVia: via },
        via,
        closed: false,
        notes,
      }
    }
    catch (e: any) {
      if (e instanceof HttpError && e.status === 404) {
        return {
          postingText: composeText(job.description, listedPay),
          descriptionHtml: null,
          applyUrl: null,
          atsType: ref.ats,
          atsMeta: { ...meta, resolvedVia: via },
          via,
          closed: true,
          notes: [...notes, `The posting is no longer on ${ref.board}'s ${ref.ats} board`],
        }
      }
      notes.push(`Could not load the ${ref.ats} posting: ${e?.message || e}`)
    }
  }

  if (otherAtsLink) {
    notes.push('Apply link found in the listing')
    return {
      postingText: composeText(job.description, listedPay),
      descriptionHtml: null,
      applyUrl: otherAtsLink,
      atsType: detectAts(otherAtsLink),
      atsMeta: Object.keys(meta).length ? { ...meta, resolvedVia: 'listing_link' } : null,
      via: 'listing_link',
      closed: false,
      notes,
    }
  }

  // An employer page (JSearch apply links, RemoteOK apply_url): read it directly.
  if (job.url) {
    let host = ''
    try {
      host = new URL(job.url).hostname
    }
    catch {
      // not a URL
    }
    if (host && !AGGREGATOR_HOSTS.test(host)) {
      try {
        const page = await fetchText(job.url)
        if (page.status < 400 && page.text) {
          const ld = jsonLdPosting(page.text)
          const html = ld?.description ?? sanitizeHtml(page.text.replace(/<(head|nav|header|footer)[\s\S]*?<\/\1>/gi, ''))
          const ats = detectAts(page.finalUrl)
          return {
            postingText: composeText(html, [...(ld?.payLine ? [ld.payLine] : []), ...listedPay]),
            descriptionHtml: null,
            applyUrl: page.finalUrl,
            atsType: ats,
            atsMeta: Object.keys(meta).length ? { ...meta, resolvedVia: 'employer_page' } : null,
            via: 'employer_page',
            closed: false,
            notes,
          }
        }
        notes.push(`Employer page answered HTTP ${page.status}`)
      }
      catch (e: any) {
        notes.push(`Employer page failed: ${e?.message || e}`)
      }
    }
  }

  if (job.source === 'remotive') notes.push('Remotive hides the employer link behind a login, and no matching posting was found on the company\'s Greenhouse, Lever, or Ashby board')
  else if (job.source === 'adzuna') notes.push('Adzuna\'s redirect blocks automated clients, and no matching posting was found on the company\'s Greenhouse, Lever, or Ashby board')
  else notes.push('No employer application form found')

  return {
    postingText: composeText(job.description, listedPay),
    descriptionHtml: null,
    applyUrl: null,
    atsType: 'unknown',
    atsMeta: Object.keys(meta).length ? meta : null,
    via: 'none',
    closed: false,
    notes,
  }
}

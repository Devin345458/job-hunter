import { and, eq, inArray, isNotNull, or } from 'drizzle-orm'
import { jobs } from '../../db/schema'
import { ATS_BOARDS, type BoardAts } from './ats-boards'
import { jobBoards, nowIso, pullDb } from './pull-state'

// Grows the employer board list on its own. When a listing's apply link (or a link in its
// description, or the form enrichment resolved later) points at a company's board on a supported
// applicant tracking system, that board is recorded and pulled in later searches like the curated
// ones in ats-boards.ts. A board that answers 404 is marked gone and skipped.
//
// The URL parsing is a copy of the board part of parseAtsUrl() in enrich/ats.ts (which imports
// ats-boards.ts, so importing it here would make a cycle), extended to the other systems.

/** Systems with a public per-company job list. The curated list in ats-boards.ts covers the first three. */
export type AnyBoardAts = BoardAts | 'workable' | 'smartrecruiters' | 'recruitee' | 'rippling' | 'gem'

export interface BoardRef {
  ats: AnyBoardAts
  token: string
}

export interface Board {
  ats: AnyBoardAts
  token: string
  company: string
  discovered: boolean
}

const RESERVED = new Set(['embed', 'jobs', 'job', 'api', 'v1', 'boards', 'careers', 'j', 'o', 'p', 'apply', 'www', 'static', 'assets', 'sitemap.xml', 'robots.txt'])

// SmartRecruiters company identifiers are case-sensitive ("Visa" and "visa" differ), so they keep their case.
const CASE_SENSITIVE = new Set<AnyBoardAts>(['smartrecruiters'])

function cleanToken(token: string | undefined | null, keepCase = false): string | null {
  if (!token) return null
  let t: string
  try {
    t = decodeURIComponent(token).trim()
  }
  catch {
    return null
  }
  if (!keepCase) t = t.toLowerCase()
  if (!t || RESERVED.has(t.toLowerCase()) || t.length > 80 || !/^[a-z0-9][a-z0-9._-]*$/i.test(t)) return null
  return t
}

/** The company board a link points at, on a system this app can pull. Null for anything else. */
export function boardRefFromUrl(url: string | null | undefined): BoardRef | null {
  if (!url) return null
  let u: URL
  try {
    u = new URL(url)
  }
  catch {
    return null
  }
  const host = u.hostname.toLowerCase()
  const parts = u.pathname.split('/').filter(Boolean)

  // boards.greenhouse.io/<token>/jobs/<id>, job-boards.greenhouse.io/<token>/jobs/<id>,
  // .../embed/job_app?for=<token>, boards-api.greenhouse.io/v1/boards/<token>/jobs. The EU
  // hosts use a different API and are left out.
  if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io') {
    if (u.searchParams.get('for')) return wrap('greenhouse', u.searchParams.get('for'))
    if (parts[1] === 'jobs' || parts.length === 1) return wrap('greenhouse', parts[0])
    return null
  }
  if (host === 'boards-api.greenhouse.io' && parts[0] === 'v1' && parts[1] === 'boards') return wrap('greenhouse', parts[2])
  if (host === 'jobs.lever.co') return wrap('lever', parts[0])
  if (host === 'api.lever.co' && parts[0] === 'v0' && parts[1] === 'postings') return wrap('lever', parts[2])
  if (host === 'jobs.ashbyhq.com') return wrap('ashby', parts[0])
  if (host === 'api.ashbyhq.com' && parts[0] === 'posting-api' && parts[1] === 'job-board') return wrap('ashby', parts[2])
  // apply.workable.com/<token>/j/<shortcode>; apply.workable.com/j/<shortcode> names no company. Older boards: <token>.workable.com.
  if (host === 'apply.workable.com') return wrap('workable', parts[0])
  if (host.endsWith('.workable.com') && host.split('.').length === 3 && !['www', 'jobs', 'apply', 'help', 'resources'].includes(host.split('.')[0]!)) return wrap('workable', host.split('.')[0])
  // jobs.smartrecruiters.com/<CompanyIdentifier>/<id>, careers.smartrecruiters.com/<CompanyIdentifier>
  if (host === 'jobs.smartrecruiters.com' || host === 'careers.smartrecruiters.com') return wrap('smartrecruiters', parts[0])
  if (host === 'api.smartrecruiters.com' && parts[0] === 'v1' && parts[1] === 'companies') return wrap('smartrecruiters', parts[2])
  // <token>.recruitee.com/o/<slug>
  if (host.endsWith('.recruitee.com') && host.split('.').length === 3 && !['www', 'app', 'api', 'docs'].includes(host.split('.')[0]!)) return wrap('recruitee', host.split('.')[0])
  // ats.rippling.com/<slug>/jobs/<uuid>
  if (host === 'ats.rippling.com' && parts[1] === 'jobs') return wrap('rippling', parts[0])
  // jobs.gem.com/<board>/<id>
  if (host === 'jobs.gem.com') return wrap('gem', parts[0])
  return null
}

function wrap(ats: AnyBoardAts, token: string | null | undefined): BoardRef | null {
  const t = cleanToken(token, CASE_SENSITIVE.has(ats))
  return t ? { ats, token: t } : null
}

const LINK = /https?:\/\/(?:[a-z0-9-]+\.)*(?:greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|recruitee\.com|rippling\.com|gem\.com)\/[^\s"'<>)\]]+/gi

/** Board links inside listing text or HTML. */
export function boardLinksIn(text: string | null | undefined): string[] {
  if (!text) return []
  return [...new Set((text.match(LINK) ?? []).map(l => l.replace(/&amp;/g, '&').replace(/[.,;]+$/, '')))]
}

const keyOf = (ats: string, token: string) => `${ats}:${token.toLowerCase()}`
const curatedKeys = new Set(ATS_BOARDS.map(b => keyOf(b.ats, b.token)))

/** Curated boards for one system plus the discovered ones still answering. */
export function boardsToPull(ats: AnyBoardAts): Board[] {
  const curated: Board[] = ATS_BOARDS.filter(b => b.ats === ats).map(b => ({ ...b, discovered: false }))
  const found: Board[] = pullDb().select().from(jobBoards)
    .where(and(eq(jobBoards.ats, ats), eq(jobBoards.status, 'active')))
    .all()
    .filter(b => !curatedKeys.has(keyOf(b.ats, b.token)))
    .map(b => ({ ats: b.ats as AnyBoardAts, token: b.token, company: b.company, discovered: true }))
  return [...curated, ...found]
}

export function discoveredBoardCount(): Record<string, { active: number; gone: number }> {
  const out: Record<string, { active: number; gone: number }> = {}
  for (const b of pullDb().select({ ats: jobBoards.ats, status: jobBoards.status }).from(jobBoards).all()) {
    const entry = out[b.ats] ??= { active: 0, gone: 0 }
    if (b.status === 'gone') entry.gone++
    else entry.active++
  }
  return out
}

export interface BoardCandidate {
  url: string | null | undefined
  company: string
  via: string
}

/** Records boards not seen before. Returns the ones added. */
export function recordBoards(candidates: BoardCandidate[]): BoardRef[] {
  const db = pullDb()
  const known = new Set([
    ...curatedKeys,
    ...db.select({ ats: jobBoards.ats, token: jobBoards.token }).from(jobBoards).all().map(b => keyOf(b.ats, b.token)),
  ])
  const added: BoardRef[] = []
  for (const c of candidates) {
    const ref = boardRefFromUrl(c.url)
    if (!ref) continue
    const key = keyOf(ref.ats, ref.token)
    if (known.has(key)) continue
    known.add(key)
    const now = nowIso()
    db.insert(jobBoards).values({ ats: ref.ats, token: ref.token, company: c.company.trim() || ref.token, foundVia: c.via.slice(0, 200), createdAt: now, updatedAt: now })
      .onConflictDoNothing()
      .run()
    added.push(ref)
  }
  return added
}

/**
 * Boards named by jobs already stored: the employer form enrichment resolved (apply_url), the
 * listing link, and the posting URL enrichment kept in ats_meta. Runs at the start of every search.
 */
export function discoverFromJobs(): BoardRef[] {
  const rows = pullDb().select({ id: jobs.id, source: jobs.source, company: jobs.company, url: jobs.url, applyUrl: jobs.applyUrl, atsMeta: jobs.atsMeta })
    .from(jobs)
    .where(and(
      or(isNotNull(jobs.applyUrl), isNotNull(jobs.url)),
      eq(jobs.isSandbox, false),
    ))
    .all()
  const candidates: BoardCandidate[] = []
  for (const r of rows) {
    const via = `job #${r.id} (${r.source})`
    candidates.push({ url: r.applyUrl, company: r.company, via }, { url: r.url, company: r.company, via })
    if (r.atsMeta) {
      try {
        const meta = JSON.parse(r.atsMeta) as { postingUrl?: unknown }
        if (typeof meta.postingUrl === 'string') candidates.push({ url: meta.postingUrl, company: r.company, via })
      }
      catch {
        // not JSON
      }
    }
  }
  return recordBoards(candidates)
}

/** A discovered board that answered 404 is skipped from now on. Curated boards are never marked. */
export function markBoardGone(ats: AnyBoardAts, token: string, error: string) {
  pullDb().update(jobBoards).set({ status: 'gone', lastError: error.slice(0, 300), updatedAt: nowIso() })
    .where(and(eq(jobBoards.ats, ats), eq(jobBoards.token, token)))
    .run()
}

export function discoveredBoards(ats?: AnyBoardAts[]) {
  const q = pullDb().select().from(jobBoards)
  return ats?.length ? q.where(inArray(jobBoards.ats, ats)).all() : q.all()
}

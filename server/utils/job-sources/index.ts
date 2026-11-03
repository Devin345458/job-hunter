import { and, eq } from 'drizzle-orm'
import { jobs, searchConfigs } from '../../db/schema'
import * as learning from '../learning'
import * as learnedScore from '../learned-score'
import type { JobSourceAdapter, NormalizedJob, PullResult, SearchParams } from './types'
import { SourceUnavailable } from './types'
import { jsearchAdapter } from './jsearch'
import { adzunaAdapter } from './adzuna'
import { remotiveAdapter } from './remotive'
import { remoteokAdapter } from './remoteok'
import { himalayasAdapter } from './himalayas'
import { jobicyAdapter } from './jobicy'
import { arbeitnowAdapter } from './arbeitnow'
import { greenhouseAdapter } from './greenhouse'
import { leverAdapter } from './lever'
import { ashbyAdapter } from './ashby'
import { hackernewsAdapter } from './hackernews'
import { weworkremotelyAdapter } from './weworkremotely'
import { workingnomadsAdapter } from './workingnomads'
import { workablejobsAdapter } from './workablejobs'
import { workableAdapter } from './workable'
import { smartrecruitersAdapter } from './smartrecruiters'
import { recruiteeAdapter } from './recruitee'
import { ripplingAdapter } from './rippling'
import { gemAdapter } from './gem'
import { listingRejection, normalizeCompany } from './filters'
import { endRunCache, sourceWarnings, startRunCache } from './http'
import { filterHash, lastAttempt, MAX_AGE_DAYS, nowIso, pullRows, recordPull } from './pull-state'
import { type BoardCandidate, boardLinksIn, discoverFromJobs, recordBoards } from './board-discovery'

/** Aggregators a search config can pick in its job_sources list. */
export const AGGREGATOR_ADAPTERS: Record<string, JobSourceAdapter> = {
  jsearch: jsearchAdapter,
  adzuna: adzunaAdapter,
  remotive: remotiveAdapter,
  remoteok: remoteokAdapter,
  himalayas: himalayasAdapter,
  jobicy: jobicyAdapter,
  arbeitnow: arbeitnowAdapter,
  hackernews: hackernewsAdapter,
  weworkremotely: weworkremotelyAdapter,
  workingnomads: workingnomadsAdapter,
  workablejobs: workablejobsAdapter,
}

/**
 * Employer job boards (curated in ats-boards.ts, plus boards found through apply links in
 * board-discovery.ts). They run for every active config, whatever its job_sources list says: the
 * boards are free public APIs, and every listing links straight to the employer's form. The last
 * five have no curated boards and only pull boards that discovery has found.
 */
export const BOARD_ADAPTERS: Record<string, JobSourceAdapter> = {
  greenhouse: greenhouseAdapter,
  lever: leverAdapter,
  ashby: ashbyAdapter,
  workable: workableAdapter,
  smartrecruiters: smartrecruitersAdapter,
  recruitee: recruiteeAdapter,
  rippling: ripplingAdapter,
  gem: gemAdapter,
}

export const ALL_ADAPTERS: Record<string, JobSourceAdapter> = { ...AGGREGATOR_ADAPTERS, ...BOARD_ADAPTERS }

// Shape defined by the learning unit in shared/types/learning.ts.
import type { SearchAdjustments } from '#shared/types/learning'

/**
 * Search changes learned from Devin's rejections, from searchAdjustments() in learning.ts.
 * The learning unit adds that export; until it lands this returns null and search runs unchanged.
 */
export async function loadSearchAdjustments(): Promise<SearchAdjustments | null> {
  const exportName: string = 'searchAdjustments'
  const fn = (learning as Record<string, unknown>)[exportName]
  if (typeof fn !== 'function') return null
  const result = await (fn as () => SearchAdjustments | Promise<SearchAdjustments>)()
  return {
    excludedKeywords: result?.excludedKeywords ?? [],
    excludedCompanies: result?.excludedCompanies ?? [],
    boostKeywords: result?.boostKeywords ?? [],
  }
}

type ExclusionCheck = (listing: NormalizedJob, adj: SearchAdjustments) => string | null

/**
 * learnedSearchExclusion() from learned-score.ts (learning unit) does the whole learned check
 * for one listing and returns a reason or null. Until it lands, search falls back to merging the
 * learned excluded keywords into the title filter and matching excluded companies here.
 */
function learnedExclusionCheck(): ExclusionCheck | null {
  const exportName: string = 'learnedSearchExclusion'
  const fn = (learnedScore as Record<string, unknown>)[exportName]
  return typeof fn === 'function' ? fn as ExclusionCheck : null
}

export interface SourceRunStat {
  /** waiting: skipped this run because the source limits how often we may ask. partial: some keywords or boards failed. */
  status: 'ok' | 'partial' | 'unavailable' | 'failed' | 'waiting'
  /** Listings the source returned inside the window (14 days, or since the watermark), before filters. */
  found: number
  /** Of those, how many passed the config's filters and the learned search exclusions. */
  passed: number
  /** Passed, but already stored (same source and source id). */
  known: number
  /** Stored by this run. Every new job is queued for enrichment; nothing else is. */
  new: number
  queued: number
  requests: number
  /** full: the whole window was read; incremental: only listings since the watermark; mixed: some of each. */
  mode?: 'full' | 'incremental' | 'mixed'
  /** Keywords or boards pulled, and how many of them failed. */
  scopes?: number
  scopesFailed?: number
  /** Listings dropped by the filters, by reason. */
  dropped?: Record<string, number>
  /** When a waiting source may be asked again. */
  waitUntil?: string
  error?: string
  warnings?: string[]
}

export interface SearchRunStats extends Record<string, unknown> {
  configs: number
  found: number
  passed: number
  known: number
  new: number
  queued: number
  sources: Record<string, SourceRunStat>
  adjustments: { excludedKeywords: number; excludedCompanies: number; boostKeywords: number } | 'not available'
  /** Listings dropped by learned search rules, by reason. */
  learnedExclusions: Record<string, number>
  /** Employer boards added this run from apply links. */
  boardsDiscovered: number
  /** Ids of the jobs stored by this run, in insert order: the enrich queue's input. */
  newJobIds: number[]
}

function parseList(value: string | null | undefined): string[] | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : undefined
  }
  catch {
    return undefined
  }
}

/** Stores a listing not seen before (dedupe on source + source_id). Returns the new job id, or null when known. */
function insertIfNew(job: NormalizedJob): number | null {
  const db = useDb()
  const existing = db.select({ id: jobs.id }).from(jobs)
    .where(and(eq(jobs.source, job.source), eq(jobs.sourceId, job.sourceId)))
    .get()
  if (existing) return null
  const row = db.insert(jobs).values({
    source: job.source,
    sourceId: job.sourceId,
    title: job.title,
    company: job.company,
    companyUrl: job.companyUrl ?? null,
    location: job.location ?? null,
    remoteType: job.remoteType ?? null,
    salaryMin: job.salaryMin ?? null,
    salaryMax: job.salaryMax ?? null,
    salaryCurrency: job.salaryCurrency ?? null,
    description: job.description || null,
    url: job.url ?? null,
    tags: job.tags?.length ? JSON.stringify(job.tags) : null,
    expiresAt: job.expiresAt ?? null,
    applyUrl: job.applyUrl ?? null,
    atsType: job.atsType ?? null,
    atsMeta: job.atsMeta ? JSON.stringify(job.atsMeta) : null,
  }).returning({ id: jobs.id }).get()
  return row.id
}

function emptyStat(): SourceRunStat {
  return { status: 'ok', found: 0, passed: 0, known: 0, new: 0, queued: 0, requests: 0 }
}

/** A source without pull(): its search() result, already filtered by the source, as one scope. */
async function pullViaSearch(adapter: JobSourceAdapter, params: SearchParams): Promise<PullResult> {
  const jobsFound = await adapter.search(params)
  return {
    listings: jobsFound.map(job => ({ job, postedAt: null, locations: [job.location ?? ''], remote: job.remoteType === 'remote', fullTime: true, scope: '' })),
    scopes: [{ scope: '', ok: true, found: jobsFound.length, requests: 1, complete: true }],
  }
}

/**
 * Runs every active search config against its aggregators plus the employer boards, and stores
 * listings not seen before (dedupe on source + source_id). Used by the jobs:search task and by
 * POST /api/jobs/search.
 *
 * Each source pages through everything inside its window: the last 14 days on a source's first
 * pull (boards: every open posting), then only what was posted or changed since its watermark,
 * kept per source, config, and keyword or board in source_pulls (pull-state.ts). The config's
 * filters and the learned search exclusions run before anything is stored, so more listings
 * read does not mean more jobs queued for enrichment. A failed pull leaves its watermark alone.
 */
export async function runSearch(log: (msg: string) => void = console.log, opts: { onNewJob?: (jobId: number) => void } = {}): Promise<SearchRunStats> {
  const db = useDb()
  const configs = db.select().from(searchConfigs).where(eq(searchConfigs.isActive, true)).all()
  const stats: SearchRunStats = { configs: configs.length, found: 0, passed: 0, known: 0, new: 0, queued: 0, sources: {}, adjustments: 'not available', learnedExclusions: {}, boardsDiscovered: 0, newJobIds: [] }
  if (!configs.length) {
    log('no active search configs')
    return stats
  }

  const fromJobs = discoverFromJobs()
  stats.boardsDiscovered += fromJobs.length
  if (fromJobs.length) log(`boards added from stored apply links: ${fromJobs.map(b => `${b.ats}/${b.token}`).join(', ')}`)

  const adjustments = await loadSearchAdjustments()
  if (adjustments) {
    stats.adjustments = {
      excludedKeywords: adjustments.excludedKeywords.length,
      excludedCompanies: adjustments.excludedCompanies.length,
      boostKeywords: adjustments.boostKeywords.length,
    }
  }
  const sharedCheck = adjustments ? learnedExclusionCheck() : null
  const excludedCompanies = new Set((adjustments?.excludedCompanies ?? []).map(normalizeCompany))
  const exclusionReason = (job: NormalizedJob): string | null => {
    if (!adjustments) return null
    if (sharedCheck) return sharedCheck(job, adjustments)
    return excludedCompanies.has(normalizeCompany(job.company)) ? `learned rule: company ${job.company}` : null
  }

  // Sources whose terms limit how often we may ask sit out until their interval has passed.
  const waiting = new Map<string, string>()
  for (const [name, adapter] of Object.entries(ALL_ADAPTERS)) {
    if (!adapter.minIntervalMinutes) continue
    const last = lastAttempt(name)
    const until = last ? Date.parse(last) + adapter.minIntervalMinutes * 60000 : 0
    if (until > Date.now()) waiting.set(name, new Date(until).toISOString())
  }

  const boardCandidates: BoardCandidate[] = []
  startRunCache()
  try {
    for (const config of configs) {
      const keywords = [...new Set([...(parseList(config.keywords) ?? []), ...(adjustments?.boostKeywords ?? [])])]
      const params: SearchParams = {
        keywords,
        // With the shared check, learned keywords are applied there (once), not in the title filter too.
        excludedKeywords: [...new Set([...(parseList(config.excludedKeywords) ?? []), ...(sharedCheck ? [] : adjustments?.excludedKeywords ?? [])])],
        locations: parseList(config.locations),
        remoteOnly: config.remoteOnly ?? false,
        salaryMin: config.salaryMin ?? undefined,
        salaryCurrency: config.salaryCurrency ?? 'USD',
      }
      const hash = filterHash(params)
      const chosen = parseList(config.jobSources) ?? Object.keys(AGGREGATOR_ADAPTERS)
      const names = [...new Set([...chosen, ...Object.keys(BOARD_ADAPTERS)])]
      const startedAt = nowIso()
      const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 86400000)
      log(`config "${config.name}": ${names.join(', ')}`)

      const pulls = await Promise.allSettled(names.map(async (name) => {
        const adapter = ALL_ADAPTERS[name]
        if (!adapter) throw new Error(`Unknown source "${name}"`)
        if (waiting.has(name)) return { name, adapter, result: null, since: () => null }
        const rows = pullRows(name, config.id)
        const overlapMs = (adapter.overlapHours ?? 1) * 3600000
        const since = (scope: string): Date | null => {
          const row = rows.get(scope)
          if (!row?.lastPulledAt || row.filterHash !== hash) return null
          return new Date(Date.parse(row.lastPulledAt) - overlapMs)
        }
        const result = adapter.pull
          ? await adapter.pull(params, { cutoff, since, log: msg => log(`${name}: ${msg}`) })
          : await pullViaSearch(adapter, params)
        return { name, adapter, result, since }
      }))

      pulls.forEach((settled, i) => {
        const name = names[i]!
        const stat = stats.sources[name] ??= emptyStat()
        const warnings = sourceWarnings.get(name)
        if (warnings?.length) stat.warnings = warnings.slice(0, 10)

        if (settled.status === 'rejected') {
          const e = settled.reason
          stat.status = e instanceof SourceUnavailable ? 'unavailable' : 'failed'
          stat.error = String(e?.message || e).slice(0, 300)
          log(`${name}: ${stat.status}: ${stat.error}`)
          if (ALL_ADAPTERS[name]) recordPull({ source: name, configId: config.id, scope: '', startedAt, hash, status: stat.status === 'unavailable' ? 'unavailable' : 'failed', mode: 'full', error: stat.error })
          return
        }
        const { result, since } = settled.value
        if (!result) {
          stat.status = 'waiting'
          stat.waitUntil = waiting.get(name)
          log(`${name}: waiting until ${stat.waitUntil} (the source limits how often it may be asked)`)
          return
        }

        // Per scope counts, for the source_pulls rows.
        const perScope = new Map<string, { passed: number; known: number; added: number }>()
        const seen = new Set<string>()
        for (const listing of result.listings) {
          if (seen.has(listing.job.sourceId)) continue
          seen.add(listing.job.sourceId)
          const counts = perScope.get(listing.scope) ?? { passed: 0, known: 0, added: 0 }
          perScope.set(listing.scope, counts)
          stat.found++
          stats.found++
          const rejected = listingRejection(listing, params)
          const learned = rejected ? null : exclusionReason(listing.job)
          if (rejected || learned) {
            const reason = rejected ?? 'learned search rule'
            stat.dropped = stat.dropped ?? {}
            stat.dropped[reason] = (stat.dropped[reason] ?? 0) + 1
            if (learned) stats.learnedExclusions[learned] = (stats.learnedExclusions[learned] ?? 0) + 1
            continue
          }
          counts.passed++
          stat.passed++
          stats.passed++
          boardCandidates.push(
            { url: listing.job.applyUrl, company: listing.job.company, via: `${name} listing ${listing.job.sourceId}` },
            { url: listing.job.url, company: listing.job.company, via: `${name} listing ${listing.job.sourceId}` },
            ...boardLinksIn(listing.job.description).map(url => ({ url, company: listing.job.company, via: `link in ${name} listing ${listing.job.sourceId}` })),
          )
          try {
            const id = insertIfNew(listing.job)
            if (id == null) {
              counts.known++
              stat.known++
              stats.known++
            }
            else {
              counts.added++
              stat.new++
              stat.queued++
              stats.new++
              stats.queued++
              stats.newJobIds.push(id)
              // The jobs:search task queues each new job for reading (task-queue unit).
              opts.onNewJob?.(id)
            }
          }
          catch (e: any) {
            log(`${name}: insert failed for ${listing.job.sourceId}: ${e?.message || e}`)
          }
        }

        let full = 0
        let incremental = 0
        stat.scopes = (stat.scopes ?? 0) + result.scopes.length
        for (const scope of result.scopes) {
          const mode = since(scope.scope) ? 'incremental' : 'full'
          if (mode === 'full') full++
          else incremental++
          stat.requests += scope.requests
          if (!scope.ok || !scope.complete) {
            stat.scopesFailed = (stat.scopesFailed ?? 0) + 1
            const message = `${scope.scope || name}: ${scope.error ?? 'did not finish'}`
            if (!warnings?.some(w => w.startsWith(`${scope.scope}:`))) stat.warnings = [...(stat.warnings ?? []), message].slice(0, 10)
          }
          const counts = perScope.get(scope.scope)
          recordPull({
            source: name,
            configId: config.id,
            scope: scope.scope,
            startedAt,
            hash,
            status: !scope.ok ? 'failed' : scope.complete ? 'ok' : 'partial',
            mode,
            error: scope.error ?? null,
            found: scope.found,
            passed: counts?.passed ?? 0,
            known: counts?.known ?? 0,
            added: counts?.added ?? 0,
            requests: scope.requests,
          })
        }
        stat.mode = !incremental ? 'full' : !full ? 'incremental' : 'mixed'
        if (result.scopes.length && stat.scopesFailed === result.scopes.length) {
          stat.status = 'failed'
          stat.error = result.scopes[0]?.error
        }
        else if (stat.scopesFailed) {
          stat.status = 'partial'
        }
        log(`${name}: ${stat.mode} pull, ${stat.requests} requests, found ${stat.found}, passed filters ${stat.passed}, already known ${stat.known}, new ${stat.new}${stat.scopesFailed ? `, ${stat.scopesFailed} of ${result.scopes.length} ${result.scopes.length === 1 ? 'part' : 'parts'} failed` : ''}`)
      })
    }
  }
  finally {
    endRunCache()
  }

  const added = recordBoards(boardCandidates)
  stats.boardsDiscovered += added.length
  if (added.length) log(`boards added from listing links: ${added.map(b => `${b.ats}/${b.token}`).join(', ')}`)
  return stats
}

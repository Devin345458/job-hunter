import { and, eq } from 'drizzle-orm'
import { jobs, searchConfigs } from '../../db/schema'
import * as learning from '../learning'
import * as learnedScore from '../learned-score'
import type { JobSourceAdapter, NormalizedJob, SearchParams } from './types'
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
import { normalizeCompany } from './filters'
import { sourceWarnings } from './http'

/** Aggregators a search config can pick in its job_sources list. */
export const AGGREGATOR_ADAPTERS: Record<string, JobSourceAdapter> = {
  jsearch: jsearchAdapter,
  adzuna: adzunaAdapter,
  remotive: remotiveAdapter,
  remoteok: remoteokAdapter,
  himalayas: himalayasAdapter,
  jobicy: jobicyAdapter,
  arbeitnow: arbeitnowAdapter,
}

/**
 * Employer job boards (curated in ats-boards.ts). They run for every active config, whatever
 * its job_sources list says: the settings page only offers the three original aggregators, the
 * boards are free public APIs, and every listing links straight to the employer's form.
 */
export const BOARD_ADAPTERS: Record<string, JobSourceAdapter> = {
  greenhouse: greenhouseAdapter,
  lever: leverAdapter,
  ashby: ashbyAdapter,
}

export const ALL_ADAPTERS: Record<string, JobSourceAdapter> = { ...AGGREGATOR_ADAPTERS, ...BOARD_ADAPTERS }

export interface SearchAdjustments {
  excludedKeywords: string[]
  excludedCompanies: string[]
  boostKeywords: string[]
}

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
  status: 'ok' | 'unavailable' | 'failed'
  found: number
  new: number
  error?: string
  warnings?: string[]
}

export interface SearchRunStats extends Record<string, unknown> {
  configs: number
  found: number
  new: number
  sources: Record<string, SourceRunStat>
  adjustments: { excludedKeywords: number; excludedCompanies: number; boostKeywords: number } | 'not available'
  /** Listings dropped by learned search rules, by reason. */
  learnedExclusions: Record<string, number>
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

function insertIfNew(job: NormalizedJob): boolean {
  const db = useDb()
  const existing = db.select({ id: jobs.id }).from(jobs)
    .where(and(eq(jobs.source, job.source), eq(jobs.sourceId, job.sourceId)))
    .get()
  if (existing) return false
  db.insert(jobs).values({
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
  }).run()
  return true
}

/**
 * Runs every active search config against its aggregators plus the employer boards, and
 * inserts listings not seen before (dedupe on source + source_id). Used by the jobs:search
 * task and by POST /api/jobs/search.
 */
export async function runSearch(log: (msg: string) => void = console.log): Promise<SearchRunStats> {
  const db = useDb()
  const configs = db.select().from(searchConfigs).where(eq(searchConfigs.isActive, true)).all()
  const stats: SearchRunStats = { configs: configs.length, found: 0, new: 0, sources: {}, adjustments: 'not available', learnedExclusions: {} }
  if (!configs.length) {
    log('no active search configs')
    return stats
  }

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
    const chosen = parseList(config.jobSources) ?? Object.keys(AGGREGATOR_ADAPTERS)
    const names = [...new Set([...chosen, ...Object.keys(BOARD_ADAPTERS)])]
    log(`config "${config.name}": ${names.join(', ')}`)

    const results = await Promise.allSettled(names.map((name) => {
      const adapter = ALL_ADAPTERS[name]
      return adapter ? adapter.search(params) : Promise.reject(new Error(`Unknown source "${name}"`))
    }))

    results.forEach((result, i) => {
      const name = names[i]!
      const stat = stats.sources[name] ??= { status: 'ok', found: 0, new: 0 }
      const warnings = sourceWarnings.get(name)
      if (warnings?.length) stat.warnings = warnings.slice(0, 10)
      if (result.status === 'rejected') {
        const e = result.reason
        stat.status = e instanceof SourceUnavailable ? 'unavailable' : 'failed'
        stat.error = String(e?.message || e).slice(0, 300)
        log(`${name}: ${stat.status}: ${stat.error}`)
        return
      }
      stat.found += result.value.length
      stats.found += result.value.length
      for (const job of result.value) {
        const excluded = exclusionReason(job)
        if (excluded) {
          stats.learnedExclusions[excluded] = (stats.learnedExclusions[excluded] ?? 0) + 1
          continue
        }
        try {
          if (insertIfNew(job)) {
            stat.new++
            stats.new++
          }
        }
        catch (e: any) {
          log(`${name}: insert failed for ${job.sourceId}: ${e?.message || e}`)
        }
      }
      log(`${name}: found ${stat.found}, new ${stat.new}`)
    })
  }
  return stats
}

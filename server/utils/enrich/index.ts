import { eq, inArray, isNull } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import { jobs, searchConfigs } from '../../db/schema'
import { AiBudgetExceeded, aiSpentToday } from '../ai'
import { buildCompensation, totalMidpoint } from '../compensation'
import { type KnowledgeEntry, loadKnowledge } from '../knowledge'
import { nowSql, parseJson } from '../review'
import { isSoftwareRoleTitle, matchedKeywords, matchesAnyTerm, termRegex, US_ONLY_SOURCES, usEligibility } from '../job-sources/filters'
import { mapPool } from '../job-sources/http'
import { BoardCache } from './ats'
import { extractPosting } from './extract'
import { resolvePosting } from './posting'

type JobRow = InferSelectModel<typeof jobs>

/** Jobs sent to Claude per run. The rest wait for the next run, best candidates first. */
export const ENRICH_LIMIT = 40
const SKIP_PREFIX = 'Skipped by prefilter: '

export function isPrefilterSkip(enrichError: string | null | undefined) {
  return !!enrichError?.startsWith(SKIP_PREFIX)
}

export interface PrefilterContext {
  keywords: string[]
  excluded: string[]
  skillTerms: string[]
}

export function prefilterContext(entries: KnowledgeEntry[] = loadKnowledge()): PrefilterContext {
  const configs = useDb().select().from(searchConfigs).where(eq(searchConfigs.isActive, true)).all()
  const list = (v: string | null) => parseJson<string[]>(v, [])
  return {
    keywords: [...new Set(configs.flatMap(c => list(c.keywords)))],
    excluded: [...new Set(configs.flatMap(c => list(c.excludedKeywords)))],
    skillTerms: [...new Set(entries
      .filter(e => e.category === 'skill')
      .flatMap(e => e.key.split('/'))
      .map(t => t.replace(/\.js$/i, '').trim())
      .filter(t => t.length >= 2))],
  }
}

/**
 * Cheap keyword prefilter, no Claude. Skips listings that are clearly out (excluded term in the
 * title, not a software role, located outside the US) and ranks the rest so the run cap goes to
 * the best candidates: search keyword in the title, software role, employer form known, remote,
 * and how many of Devin's skills the listing names.
 */
export function prefilter(job: JobRow, ctx: PrefilterContext): { skip: string | null; score: number; skillHits: string[] } {
  const excluded = matchesAnyTerm(job.title, ctx.excluded)
  if (excluded) return { skip: `the title contains the excluded term "${excluded}"`, score: 0, skillHits: [] }
  const keywordHits = matchedKeywords(job.title, ctx.keywords)
  const software = isSoftwareRoleTitle(job.title)
  if (!software && !keywordHits.length) return { skip: 'not a software engineering role', score: 0, skillHits: [] }
  if (!job.isSandbox && !US_ONLY_SOURCES.has(job.source) && usEligibility([job.location]) === 'non_us') return { skip: `the location "${job.location}" is outside the United States`, score: 0, skillHits: [] }
  const text = `${job.title}\n${(job.description ?? '').replace(/<[^>]+>/g, ' ')}`
  const skillHits = ctx.skillTerms.filter(t => termRegex(t).test(text))
  const score = (keywordHits.length ? 3 : 0)
    + (software ? 2 : 0)
    + (job.applyUrl ? 2 : 0)
    + (job.remoteType === 'remote' ? 1 : 0)
    + Math.min(4, skillHits.length)
  return { skip: null, score, skillHits }
}

/**
 * Takes the best candidates one source at a time, in turn, until the cap is reached. Greenhouse
 * listings arrive without a description, so on score alone they would always lose to sources
 * whose descriptions name Devin's skills.
 */
export function roundRobinBySource<T extends { job: JobRow }>(ranked: T[], limit: number): T[] {
  const bySource = new Map<string, T[]>()
  for (const item of ranked) {
    const list = bySource.get(item.job.source) ?? []
    list.push(item)
    bySource.set(item.job.source, list)
  }
  const queues = [...bySource.values()]
  const out: T[] = []
  while (out.length < limit && queues.some(q => q.length)) {
    for (const q of queues) {
      const next = q.shift()
      if (next) out.push(next)
      if (out.length >= limit) break
    }
  }
  return out
}

export interface EnrichStats extends Record<string, unknown> {
  pending: number
  skipped: number
  skipReasons: Record<string, number>
  selected: number
  enriched: number
  failed: number
  closed: number
  noPostingText: number
  applyUrlFound: number
  byAts: Record<string, number>
  byVia: Record<string, number>
  compStated: number
  budgetStopped: boolean
  costUsd: number
  errors: string[]
}

/**
 * jobs:enrich. For jobs without enriched_at: resolve the full posting and the employer form,
 * then one Claude call extracts compensation (with quotes) and requirements (against the
 * knowledge base). Every processed job gets enriched_at, including failures, so a broken
 * posting is not retried every day. Pass jobIds to enrich specific jobs regardless of the cap.
 */
export async function enrichJobs(opts: { limit?: number; jobIds?: number[]; log?: (msg: string) => void } = {}): Promise<EnrichStats> {
  const db = useDb()
  const log = opts.log ?? console.log
  const limit = opts.limit ?? ENRICH_LIMIT
  const entries = loadKnowledge()
  const ctx = prefilterContext(entries)
  const stats: EnrichStats = { pending: 0, skipped: 0, skipReasons: {}, selected: 0, enriched: 0, failed: 0, closed: 0, noPostingText: 0, applyUrlFound: 0, byAts: {}, byVia: {}, compStated: 0, budgetStopped: false, costUsd: 0, errors: [] }

  const rows = opts.jobIds?.length
    ? db.select().from(jobs).where(inArray(jobs.id, opts.jobIds)).all()
    : db.select().from(jobs).where(isNull(jobs.enrichedAt)).all()
  stats.pending = rows.length

  const ranked: Array<{ job: JobRow; score: number }> = []
  for (const job of rows) {
    const p = prefilter(job, ctx)
    if (p.skip && !opts.jobIds?.length) {
      stats.skipped++
      const reason = p.skip.replace(/".*"/, '"..."')
      stats.skipReasons[reason] = (stats.skipReasons[reason] ?? 0) + 1
      db.update(jobs).set({ enrichedAt: nowSql(), enrichError: `${SKIP_PREFIX}${p.skip}` }).where(eq(jobs.id, job.id)).run()
      continue
    }
    ranked.push({ job, score: p.score })
  }
  ranked.sort((a, b) => b.score - a.score || b.job.foundAt.localeCompare(a.job.foundAt) || b.job.id - a.job.id)
  const selected = opts.jobIds?.length ? ranked : roundRobinBySource(ranked, limit)
  stats.selected = selected.length
  log(`${rows.length} pending, ${stats.skipped} skipped by prefilter, ${selected.length} selected (cap ${limit})`)

  const spentBefore = aiSpentToday()
  const cache = new BoardCache()

  await mapPool(selected, 4, async ({ job }) => {
    if (stats.budgetStopped) return
    try {
      const resolved = await resolvePosting(job, cache)
      // Sandbox jobs point at this app's own test form; never relabel them. A board listing already
      // carries its form URL; a failed detail fetch must not erase it.
      const keepSource = (job.isSandbox && !!job.applyUrl) || (!resolved.applyUrl && !resolved.closed && !!job.applyUrl)
      const base: Partial<JobRow> = {
        applyUrl: keepSource ? job.applyUrl : resolved.applyUrl,
        atsType: keepSource ? job.atsType : resolved.atsType,
        atsMeta: (resolved.atsMeta || resolved.notes.length) ? JSON.stringify({ ...(resolved.atsMeta ?? {}), enrichNotes: resolved.notes }) : job.atsMeta,
        postingText: resolved.postingText,
        ...(!job.description && resolved.descriptionHtml ? { description: resolved.descriptionHtml } : {}),
      }
      stats.byVia[resolved.via] = (stats.byVia[resolved.via] ?? 0) + 1
      stats.byAts[base.atsType ?? 'unknown'] = (stats.byAts[base.atsType ?? 'unknown'] ?? 0) + 1
      if (base.applyUrl) stats.applyUrlFound++

      if (resolved.closed) {
        stats.closed++
        db.update(jobs).set({ ...base, status: 'expired', enrichedAt: nowSql(), enrichError: resolved.notes.join(' ') }).where(eq(jobs.id, job.id)).run()
        log(`#${job.id} closed: ${resolved.notes.join(' ')}`)
        return
      }
      if (!resolved.postingText || resolved.postingText.length < 150) {
        stats.noPostingText++
        db.update(jobs).set({ ...base, enrichedAt: nowSql(), enrichError: `No posting text to read. ${resolved.notes.join(' ')}`.trim() }).where(eq(jobs.id, job.id)).run()
        return
      }

      const extraction = await extractPosting(job, resolved.postingText, entries)
      const comp = buildCompensation(extraction.compensation, resolved.postingText)
      if (comp.confidence === 'stated') stats.compStated++
      db.update(jobs).set({
        ...base,
        compJson: JSON.stringify(comp),
        totalCompEstimate: totalMidpoint(comp),
        requirementsJson: JSON.stringify(extraction.requirements),
        ...(job.salaryMin == null && job.salaryMax == null && comp.baseAnnualMin != null ? { salaryMin: comp.baseAnnualMin, salaryMax: comp.baseAnnualMax, salaryCurrency: comp.currency } : {}),
        enrichedAt: nowSql(),
        enrichError: null,
      }).where(eq(jobs.id, job.id)).run()
      stats.enriched++
      log(`#${job.id} ${job.company} | ${job.title}: ${resolved.atsType} via ${resolved.via}, comp ${comp.confidence}, ${extraction.requirements.length} requirements`)
    }
    catch (e: any) {
      if (e instanceof AiBudgetExceeded) {
        stats.budgetStopped = true
        stats.errors.push(e.message)
        return // enriched_at stays null so the job is picked up after the budget resets
      }
      stats.failed++
      const message = String(e?.message || e).slice(0, 500)
      stats.errors.push(`#${job.id}: ${message}`)
      db.update(jobs).set({ enrichedAt: nowSql(), enrichError: message }).where(eq(jobs.id, job.id)).run()
      log(`#${job.id} failed: ${message}`)
    }
  })

  stats.costUsd = Math.round((aiSpentToday() - spentBefore) * 10000) / 10000
  stats.errors = stats.errors.slice(0, 10)
  return stats
}

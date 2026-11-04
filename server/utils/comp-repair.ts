import { eq, inArray, isNotNull } from 'drizzle-orm'
import type { CompensationBreakdown } from '#shared/types/pipeline'
import { compParts, countsTowardTotal } from '#shared/utils/comp-parts'
import { appSettings, jobs } from '../db/schema'
import { useDb } from './db'
import { matchDetailSuffix, totalMidpoint } from './compensation'
import { nowSql, parseJson } from './review'
import { rescoreJobs } from './scoring'

// One-time repair, 2026-11-04. Until then a retirement match given as a percent ("401(k) with up
// to 4% match") was valued at that percent of the base midpoint and the same figure was added to
// both ends of the total, while a percent bonus already applied to each end. Rows stored before
// the fix say so in the benefit's detail ("(4% of the base midpoint)"). This reads the percent back
// from that text, stores it on the benefit, rewords the detail, and recomputes the totals with
// compParts(), the code buildCompensation() now uses. A percent bonus stored before the fix kept
// no percent; it is read back from the stored totals and checked against all three stored
// figures, and a row where that check fails is left as it is. No Claude call: the jobs whose
// totals moved are then rescored from their stored skills (rescoreJobs), which redoes only the
// code part of the score (pay against the floor and target, and learned rules).

export const COMP_REPAIR_KEY = 'comp_percent_match_repair'

const OLD_MATCH_SUFFIX = /\s*\((\d+(?:\.\d+)?)% of the base midpoint\)/

export interface CompRepairResult {
  ran: boolean
  /** Jobs whose stored breakdown changed in any way. */
  changed: number[]
  /** Jobs whose total range moved. */
  totalsChanged: number[]
  /** Jobs whose total_comp_estimate (the midpoint) moved. */
  midpointChanged: number[]
  /** Jobs whose percent bonus was read back from the stored totals. */
  bonusPercentRecovered: number[]
  /** Jobs left as they were because a stored percent bonus could not be read back exactly. */
  skipped: number[]
  /** Jobs whose stored score changed on the rescore, and those whose final score moved. */
  rescored: number
  finalScoreChanged: number[]
}

/** The percent a stored bonus applied to each end, read back from totals made before the fix. Null for a flat bonus; undefined when it cannot be read back exactly. */
export function recoverBonusPercent(c: CompensationBreakdown): number | null | undefined {
  const bonus = c.bonus
  if (!bonus || bonus.estimatedAnnual == null || bonus.percentOfBase != null) return null
  const lo = c.baseAnnualMin ?? c.baseAnnualMax
  const hi = c.baseAnnualMax ?? c.baseAnnualMin
  if (lo == null || hi == null || c.totalEstimateMin == null || c.totalEstimateMax == null) return null
  // Before the fix every other part added the same amount at both ends.
  const flat = (c.equity?.estimatedAnnual ?? 0) + c.benefits.reduce((s, b) => s + (countsTowardTotal(b) ? b.estimatedAnnualValue ?? 0 : 0), 0)
  const bonusLow = c.totalEstimateMin - lo - flat
  const bonusHigh = c.totalEstimateMax - hi - flat
  if (bonusLow === bonusHigh) return bonusLow === bonus.estimatedAnnual ? null : undefined
  const mid = (lo + hi) / 2
  const fits = (p: number) => Math.round(lo * p / 100) === bonusLow && Math.round(hi * p / 100) === bonusHigh && Math.round(mid * p / 100) === bonus.estimatedAnnual
  const candidates = [bonusHigh / hi, bonusLow / lo, bonus.estimatedAnnual / mid].flatMap(r => [Math.round(r * 100), Math.round(r * 1000) / 10, Math.round(r * 10000) / 100])
  return candidates.find(p => p > 0 && p <= 100 && fits(p)) ?? undefined
}

/** The breakdown with the percent stored on each midpoint match and on a percent bonus, and its totals recomputed. Null when a percent bonus cannot be read back. */
export function repairedComp(c: CompensationBreakdown): CompensationBreakdown | null {
  const bonusPercent = recoverBonusPercent(c)
  if (bonusPercent === undefined) return null
  const benefits = c.benefits.map((b) => {
    if (b.percentOfBase != null || b.category !== 'retirement') return b
    const m = b.detail.match(OLD_MATCH_SUFFIX)
    if (!m) return b
    const percent = Number(m[1])
    return { ...b, detail: b.detail.replace(OLD_MATCH_SUFFIX, ` (${matchDetailSuffix(percent)})`), percentOfBase: percent }
  })
  const bonus = c.bonus && bonusPercent != null ? { ...c.bonus, percentOfBase: bonusPercent } : c.bonus
  const next = { ...c, bonus, benefits }
  const totals = compParts(next)
  const hasBase = (c.baseAnnualMin ?? c.baseAnnualMax) != null
  return { ...next, totalEstimateMin: hasBase ? totals.totalMin : null, totalEstimateMax: hasBase ? totals.totalMax : null }
}

/**
 * Runs once (an app_settings marker), at the worker's start after the deploy. Additive: no row is
 * deleted and nothing but comp_json, total_comp_estimate, and the code part of the score changes.
 */
export async function repairCompTotalsOnce(log: (m: string) => void = () => {}): Promise<CompRepairResult> {
  const db = useDb()
  const result: CompRepairResult = { ran: false, changed: [], totalsChanged: [], midpointChanged: [], bonusPercentRecovered: [], skipped: [], rescored: 0, finalScoreChanged: [] }
  // Check and claim the marker in one write transaction, so a second process starting at the same time skips it.
  const claimed = db.transaction((tx) => {
    if (tx.select({ key: appSettings.key }).from(appSettings).where(eq(appSettings.key, COMP_REPAIR_KEY)).get()) return false
    tx.insert(appSettings).values({ key: COMP_REPAIR_KEY, valueJson: JSON.stringify({ started: true }), updatedAt: nowSql() }).run()
    const rows = tx.select({ id: jobs.id, compJson: jobs.compJson, total: jobs.totalCompEstimate }).from(jobs).where(isNotNull(jobs.compJson)).all()
    for (const row of rows) {
      const comp = parseJson<CompensationBreakdown | null>(row.compJson, null)
      if (!comp?.benefits) continue
      const next = repairedComp(comp)
      if (!next) {
        result.skipped.push(row.id)
        continue
      }
      const json = JSON.stringify(next)
      if (json === JSON.stringify(comp)) continue
      const midpoint = totalMidpoint(next)
      tx.update(jobs).set({ compJson: json, totalCompEstimate: midpoint }).where(eq(jobs.id, row.id)).run()
      result.changed.push(row.id)
      if (next.totalEstimateMin !== comp.totalEstimateMin || next.totalEstimateMax !== comp.totalEstimateMax) result.totalsChanged.push(row.id)
      if ((midpoint ?? null) !== (row.total ?? null)) result.midpointChanged.push(row.id)
      if (next.bonus?.percentOfBase != null && comp.bonus?.percentOfBase == null) result.bonusPercentRecovered.push(row.id)
    }
    return true
  })
  if (!claimed) return result
  result.ran = true

  const before = new Map(result.changed.length
    ? db.select({ id: jobs.id, score: jobs.matchScore }).from(jobs).where(inArray(jobs.id, result.changed)).all().map(r => [r.id, r.score])
    : [])
  result.rescored = (await rescoreJobs(result.changed, 'rescore')).rescored
  if (result.changed.length) {
    for (const r of db.select({ id: jobs.id, score: jobs.matchScore }).from(jobs).where(inArray(jobs.id, result.changed)).all()) {
      if (r.score !== before.get(r.id)) result.finalScoreChanged.push(r.id)
    }
  }

  const summary = {
    changed: result.changed.length,
    totalsChanged: result.totalsChanged.length,
    midpointChanged: result.midpointChanged,
    bonusPercentRecovered: result.bonusPercentRecovered,
    skipped: result.skipped,
    rescored: result.rescored,
    finalScoreChanged: result.finalScoreChanged,
  }
  db.update(appSettings).set({ valueJson: JSON.stringify(summary), updatedAt: nowSql() }).where(eq(appSettings.key, COMP_REPAIR_KEY)).run()
  log(`pay totals repair: ${result.changed.length} jobs updated (${result.totalsChanged.length} total ranges moved, ${result.midpointChanged.length} midpoints moved, ${result.bonusPercentRecovered.length} bonus percents read back, ${result.skipped.length} left as they were); ${result.rescored} scores rewritten, ${result.finalScoreChanged.length} final scores moved`)
  return result
}

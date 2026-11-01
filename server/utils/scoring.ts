import { inArray, notInArray } from 'drizzle-orm'
import { eq } from 'drizzle-orm'
import { jobs, scoreHistory } from '../db/schema'
import type { ScoreBreakdown } from '#shared/types/pipeline'
import { learnedAdjustment } from './learned-score'
import { nowSql, parseJson } from './review'

// Owned by capability A (matching). Learning (capability D) calls rescoreJobs after rules
// change, so the next queue reflects them without a new Claude call per job.
//
// ==========================================================================================
// LOCAL STAND-IN written by the learning unit (cap-learning) for its proof.
// At merge, REPLACE THIS WHOLE FILE with the match unit's version. Keep the signature.
// It only swaps the learned part of each stored score: new final = old final, minus the
// old learned total, plus learnedAdjustment(job). It writes score_history only when a
// score moved, and writes an 'initial' row first for a job that had no history yet.
// ==========================================================================================

const CLOSED = ['rejected', 'expired', 'applied']

export async function rescoreJobs(jobIds: number[] | 'open', reason: 'rescore' | 'rule_change'): Promise<{ rescored: number }> {
  const db = useDb()
  const rows = jobIds === 'open'
    ? db.select().from(jobs).where(notInArray(jobs.status, CLOSED)).all()
    : jobIds.length ? db.select().from(jobs).where(inArray(jobs.id, jobIds)).all() : []
  let rescored = 0
  for (const job of rows) {
    const breakdown = parseJson<ScoreBreakdown | null>(job.scoreBreakdown, null)
    const oldFinal = breakdown?.final ?? job.matchScore
    if (oldFinal == null) continue // never scored: the match step scores it first
    const oldLearned = breakdown?.learned.total ?? job.learnedAdjustment ?? 0
    const learned = learnedAdjustment(job)
    const final = Math.max(0, Math.min(100, Math.round(oldFinal - oldLearned + learned.total)))
    const now = nowSql()
    const nextBreakdown: ScoreBreakdown | null = breakdown
      ? { ...breakdown, final, learned, computedAt: new Date().toISOString() }
      : null
    if (final === oldFinal && learned.total === oldLearned) {
      // Same score. Refresh the stored explanation text if a rule's wording changed, but this
      // is not a score move, so no history row.
      if (breakdown && JSON.stringify(learned.components) !== JSON.stringify(breakdown.learned.components)) {
        db.update(jobs).set({ scoreBreakdown: JSON.stringify(nextBreakdown) }).where(eq(jobs.id, job.id)).run()
      }
      continue
    }
    const hasHistory = db.select({ id: scoreHistory.id }).from(scoreHistory).where(eq(scoreHistory.jobId, job.id)).limit(1).get()
    if (!hasHistory) {
      db.insert(scoreHistory).values({
        jobId: job.id,
        score: oldFinal,
        skillsScore: job.skillsScore,
        compScore: job.compScore,
        learnedAdjustment: oldLearned,
        breakdownJson: job.scoreBreakdown,
        reason: 'initial',
        computedAt: job.scoredAt || now,
      }).run()
    }
    db.update(jobs).set({
      matchScore: final,
      learnedAdjustment: learned.total,
      scoreBreakdown: nextBreakdown ? JSON.stringify(nextBreakdown) : job.scoreBreakdown,
      scoredAt: now,
    }).where(eq(jobs.id, job.id)).run()
    db.insert(scoreHistory).values({
      jobId: job.id,
      score: final,
      skillsScore: job.skillsScore,
      compScore: job.compScore,
      learnedAdjustment: learned.total,
      breakdownJson: nextBreakdown ? JSON.stringify(nextBreakdown) : null,
      reason,
      computedAt: now,
    }).run()
    rescored++
  }
  return { rescored }
}

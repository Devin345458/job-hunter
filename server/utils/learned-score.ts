import type { InferSelectModel } from 'drizzle-orm'
import type { jobs } from '../db/schema'
import type { ScoreComponent } from '#shared/types/pipeline'

// Owned by capability D (learning). Scoring (capability A) adds this to every job's score.
// Returns the score points that learned rules add or subtract for one job, with one
// component per rule that matched, so the dashboard can say why a score moved.
export function learnedAdjustment(job: InferSelectModel<typeof jobs>): { total: number; components: ScoreComponent[] } {
  void job
  return { total: 0, components: [] }
}

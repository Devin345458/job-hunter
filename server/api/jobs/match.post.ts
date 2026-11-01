import { isNull } from 'drizzle-orm'
import { jobs } from '~~/server/db/schema'
import { enrichJobs } from '~~/server/utils/enrich'
import { scoreJobs } from '~~/server/utils/scoring'

// Score jobs from the UI. With jobIds: enrich any of them that are not enriched yet, then score
// them. Without: the same work as the jobs:match task, capped so the request stays short.
export default defineEventHandler(async (event) => {
  const body = await readBody<{ jobIds?: number[] }>(event).catch(() => null)
  const jobIds = Array.isArray(body?.jobIds) ? body!.jobIds.map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 20) : []

  if (!loadKnowledge().length) {
    throw createError({ statusCode: 400, statusMessage: 'No knowledge base entries found. Add your profile information first.' })
  }

  if (jobIds.length) {
    const unenriched = useDb().select({ id: jobs.id, enrichedAt: jobs.enrichedAt }).from(jobs).where(isNull(jobs.enrichedAt)).all()
      .filter(j => jobIds.includes(j.id)).map(j => j.id)
    if (unenriched.length) await enrichJobs({ jobIds: unenriched })
    const stats = await scoreJobs({ jobIds })
    return { scored: stats.scored, stats }
  }

  const stats = await scoreJobs({ limit: 15 })
  return { scored: stats.scored, stats }
})

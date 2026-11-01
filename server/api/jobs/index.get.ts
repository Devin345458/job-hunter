import { eq, and, desc, sql, count, inArray } from 'drizzle-orm'
import { jobs } from '~~/server/db/schema'

export default defineEventHandler(async (event) => {
  const db = useDb()
  const query = getQuery(event)

  const status = query.status as string | undefined
  const source = query.source as string | undefined
  const search = query.search as string | undefined
  const remoteType = query.remoteType as string | undefined
  const minScore = query.minScore ? Number(query.minScore) : undefined
  const page = Math.max(1, Number(query.page) || 1)
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 20))
  const sortBy = query.sortBy as string | undefined
  const offset = (page - 1) * limit

  try {
    const conditions = []

    if (status) {
      // The jobs page sends several statuses joined by commas.
      const statuses = status.split(',').map(s => s.trim()).filter(Boolean)
      conditions.push(statuses.length > 1 ? inArray(jobs.status, statuses) : eq(jobs.status, statuses[0]!))
    }

    if (source) {
      conditions.push(eq(jobs.source, source))
    }

    if (search) {
      conditions.push(
        sql`(${jobs.title} LIKE ${'%' + search + '%'} OR ${jobs.company} LIKE ${'%' + search + '%'})`,
      )
    }

    if (remoteType) {
      conditions.push(eq(jobs.remoteType, remoteType))
    }

    if (minScore !== undefined) {
      conditions.push(sql`${jobs.matchScore} >= ${minScore}`)
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined

    const countResult = await db
      .select({ total: count() })
      .from(jobs)
      .where(where)

    const totalResult = countResult[0]

    const orderBy = sortBy === 'score'
      ? desc(jobs.matchScore)
      : desc(jobs.foundAt)

    const results = await db
      .select()
      .from(jobs)
      .where(where)
      .orderBy(orderBy)
      .limit(limit)
      .offset(offset)

    return {
      jobs: results,
      total: totalResult?.total ?? 0,
      page,
      limit,
    }
  } catch (error) {
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to fetch jobs',
    })
  }
})

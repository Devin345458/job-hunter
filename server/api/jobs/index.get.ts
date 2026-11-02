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
  const maxScore = query.maxScore ? Number(query.maxScore) : undefined
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

    if (minScore !== undefined && Number.isFinite(minScore)) {
      conditions.push(sql`${jobs.matchScore} >= ${minScore}`)
    }

    if (maxScore !== undefined && Number.isFinite(maxScore) && maxScore < 100) {
      conditions.push(sql`${jobs.matchScore} <= ${maxScore}`)
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined

    const countResult = await db
      .select({ total: count() })
      .from(jobs)
      .where(where)

    const totalResult = countResult[0]

    // id breaks ties so paging never repeats or skips a job that shares found_at with another.
    const orderBy = sortBy === 'score'
      ? [desc(jobs.matchScore), desc(jobs.id)]
      : [desc(jobs.foundAt), desc(jobs.id)]

    // Only what a job card shows. The full row (description HTML, posting text, score and pay
    // breakdowns) made a page of 20 about 110 KB; GET /api/jobs/:id serves it to the detail page.
    const results = await db
      .select({
        id: jobs.id,
        source: jobs.source,
        title: jobs.title,
        company: jobs.company,
        location: jobs.location,
        remoteType: jobs.remoteType,
        salaryMin: jobs.salaryMin,
        salaryMax: jobs.salaryMax,
        salaryCurrency: jobs.salaryCurrency,
        totalCompEstimate: jobs.totalCompEstimate,
        matchScore: jobs.matchScore,
        status: jobs.status,
        tags: jobs.tags,
        applyUrl: jobs.applyUrl,
        atsType: jobs.atsType,
        isSandbox: jobs.isSandbox,
        foundAt: jobs.foundAt,
      })
      .from(jobs)
      .where(where)
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset)

    return {
      jobs: results,
      total: totalResult?.total ?? 0,
      page,
      limit,
    }
  } catch (error) {
    console.error('[api/jobs] list failed', error)
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to fetch jobs',
    })
  }
})

import { eq, like, and, desc, sql, count } from 'drizzle-orm'
import { applications, jobs } from '~~/server/db/schema'

export default defineEventHandler(async (event) => {
  const db = useDb()
  const query = getQuery(event)

  const status = query.status as string | undefined
  const search = query.search as string | undefined
  const jobId = query.jobId ? Number(query.jobId) : undefined
  const page = Math.max(1, Number(query.page) || 1)
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 20))
  const offset = (page - 1) * limit

  try {
    const conditions = []

    if (status) {
      conditions.push(eq(applications.status, status))
    }

    if (jobId) {
      conditions.push(eq(applications.jobId, jobId))
    }

    if (search) {
      conditions.push(
        sql`(${jobs.company} LIKE ${'%' + search + '%'} OR ${jobs.title} LIKE ${'%' + search + '%'})`,
      )
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined

    const totalResultArray = await db
      .select({ total: count() })
      .from(applications)
      .leftJoin(jobs, eq(applications.jobId, jobs.id))
      .where(where)

    const totalResult = totalResultArray?.[0]

    const results = await db
      .select({
        application: applications,
        job: jobs,
        // The day of the newest employer outcome or "I submitted it", for the card's chip.
        outcomeDate: sql<string | null>`(select json_extract(d.features_json, '$.outcome.date') from decisions d
          where d.application_id = ${applications.id} and d.decision = 'outcome' order by d.id desc limit 1)`,
      })
      .from(applications)
      .leftJoin(jobs, eq(applications.jobId, jobs.id))
      .where(where)
      .orderBy(desc(applications.createdAt))
      .limit(limit)
      .offset(offset)

    return {
      applications: results.map(r => ({
        ...r.application,
        job: r.job,
        outcomeDate: r.outcomeDate,
      })),
      total: totalResult?.total,
      page,
      limit,
      // What approve does for a real employer: submit automatically, or mark it for a submit by hand.
      realSubmitEnabled: String(useRuntimeConfig().realSubmitEnabled) === 'true',
    }
  } catch (error) {
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to fetch applications',
    })
  }
})

import { eq, and, desc, sql, count, inArray, or } from 'drizzle-orm'
import { jobs } from '~~/server/db/schema'
import { IN_REVIEW_APP_STATUSES, jobGroupKey, latestApplication, toJobApplication } from '~~/server/utils/job-list'

// GET /api/jobs: one card per company and title. A company that posts the same role several times
// (Spotify's two "Staff Machine Learning Engineer, Home Surfaces" postings, Samsara's six city
// postings) stores one row per posting, because dedupe is source plus sourceId. The list groups
// those rows into one card that says how many postings it covers and where; no row is changed.
// Each card also carries its job's application, so it can say "In review" instead of "new".
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

  const appId = latestApplication('id')
  const appStatus = latestApplication('status')

  try {
    const conditions = []

    if (status) {
      // The jobs page sends several statuses joined by commas. "new" means nothing has been done
      // with the job yet, so a job with an application is not new; "in_review" is a job whose
      // application is being prepared, waits on a decision, or is being sent.
      const statuses = status.split(',').map(s => s.trim()).filter(Boolean)
      const parts = statuses.map((s) => {
        if (s === 'new') return and(eq(jobs.status, 'new'), sql`${appId} IS NULL`)
        if (s === 'in_review') return inArray(appStatus, IN_REVIEW_APP_STATUSES)
        return eq(jobs.status, s)
      })
      if (parts.length) conditions.push(parts.length > 1 ? or(...parts)! : parts[0]!)
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
    const groupKey = jobGroupKey()

    // Every matching posting, ranked inside its company and title group. The card shows the
    // posting with an application first, then the best score, then the newest. The group's best
    // score and newest find date place the card, so a group sorts where its best posting would.
    const ranked = db
      .select({
        id: jobs.id,
        rn: sql<number>`row_number() over (partition by ${groupKey} order by ${appId} is null, ${jobs.matchScore} is null, ${jobs.matchScore} desc, ${jobs.foundAt} desc, ${jobs.id} desc)`.as('rn'),
        postingCount: sql<number>`count(*) over (partition by ${groupKey})`.as('posting_count'),
        groupScore: sql<number | null>`max(${jobs.matchScore}) over (partition by ${groupKey})`.as('group_score'),
        groupFound: sql<string>`max(${jobs.foundAt}) over (partition by ${groupKey})`.as('group_found'),
      })
      .from(jobs)
      .where(where)
      .as('ranked')

    const totalResult = db.select({ total: count() }).from(ranked).where(eq(ranked.rn, 1)).get()
    const postingsResult = db.select({ total: count() }).from(jobs).where(where).get()

    // Default: best match first. Unscored groups come after every scored one, newest first within
    // equal scores. sortBy=date gives plain newest first. id breaks the remaining ties so paging
    // never repeats or skips a card.
    const orderBy = sortBy === 'date'
      ? [desc(ranked.groupFound), desc(jobs.id)]
      : [sql`${ranked.groupScore} IS NULL`, desc(ranked.groupScore), desc(ranked.groupFound), desc(jobs.id)]

    // Only what a job card shows. The full row (description HTML, posting text, score and pay
    // breakdowns) made a page of 20 about 110 KB; GET /api/jobs/:id serves it to the detail page.
    const rows = db
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
        appId,
        appStatus,
        appFormError: latestApplication('form_error'),
        postingCount: ranked.postingCount,
        groupKey: sql<string>`${groupKey}`,
      })
      .from(jobs)
      .innerJoin(ranked, eq(ranked.id, jobs.id))
      .where(eq(ranked.rn, 1))
      .orderBy(...orderBy)
      .limit(limit)
      .offset(offset)
      .all()

    // The other postings of each grouped card, inside the same filters, for its locations line.
    const grouped = rows.filter(r => r.postingCount > 1)
    const siblings = grouped.length
      ? db.select({ id: jobs.id, location: jobs.location, groupKey: sql<string>`${groupKey}` })
          .from(jobs)
          .where(and(where, inArray(groupKey, grouped.map(r => r.groupKey))))
          .orderBy(jobs.id)
          .all()
      : []

    const results = rows.map(({ appId: aId, appStatus: aStatus, appFormError, groupKey: key, ...row }) => ({
      ...row,
      application: toJobApplication(aId, aStatus, appFormError),
      // The card's own posting first, then the others in the order they were found.
      postings: row.postingCount > 1
        ? [{ id: row.id, location: row.location }, ...siblings.filter(s => s.groupKey === key && s.id !== row.id).map(s => ({ id: s.id, location: s.location }))]
        : [],
    }))

    return {
      jobs: results,
      total: totalResult?.total ?? 0,
      /** Postings behind those cards: more than total when some cards stand for several. */
      totalPostings: postingsResult?.total ?? 0,
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

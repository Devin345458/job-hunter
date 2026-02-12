import { jobs, applications, questions } from '../db/schema'
import { eq, sql, gte, and } from 'drizzle-orm'

export default defineEventHandler(async () => {
  const db = useDb()

  // Today's date in SQLite format
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayStr = today.toISOString().replace('T', ' ').substring(0, 19)

  // New jobs found today
  const [newJobsToday] = db
    .select({ count: sql<number>`count(*)` })
    .from(jobs)
    .where(gte(jobs.foundAt, todayStr))
    .all()

  // Total jobs by status
  const jobsByStatus = db
    .select({
      status: jobs.status,
      count: sql<number>`count(*)`,
    })
    .from(jobs)
    .groupBy(jobs.status)
    .all()

  // Pending questions
  const [pendingQuestions] = db
    .select({ count: sql<number>`count(*)` })
    .from(questions)
    .where(eq(questions.status, 'pending'))
    .all()

  // Applications by status
  const appsByStatus = db
    .select({
      status: applications.status,
      count: sql<number>`count(*)`,
    })
    .from(applications)
    .groupBy(applications.status)
    .all()

  // Build pipeline counts
  const pipeline: Record<string, number> = {
    draft: 0,
    ready: 0,
    submitted: 0,
    response_received: 0,
    interviewing: 0,
    rejected: 0,
    offer: 0,
  }
  for (const row of appsByStatus) {
    if (row.status in pipeline) {
      pipeline[row.status] = row.count
    }
  }

  // In-progress count (submitted + response_received + interviewing)
  const inProgress = pipeline.submitted + pipeline.response_received + pipeline.interviewing

  // Recent activity (last 10 jobs and applications combined)
  const recentJobs = db
    .select({
      id: jobs.id,
      type: sql<string>`'job'`,
      title: jobs.title,
      company: jobs.company,
      date: jobs.foundAt,
      status: jobs.status,
    })
    .from(jobs)
    .orderBy(sql`${jobs.foundAt} DESC`)
    .limit(5)
    .all()

  const recentApps = db
    .select({
      id: applications.id,
      type: sql<string>`'application'`,
      title: sql<string>`''`,
      company: sql<string>`''`,
      date: applications.createdAt,
      status: applications.status,
    })
    .from(applications)
    .orderBy(sql`${applications.createdAt} DESC`)
    .limit(5)
    .all()

  const recentActivity = [...recentJobs, ...recentApps]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 10)
    .map(item => ({
      id: item.id,
      text: item.type === 'job'
        ? `Found: ${item.title} at ${item.company}`
        : `Application ${item.status}: #${item.id}`,
      date: item.date,
      icon: item.type === 'job' ? 'mdi-briefcase-search' : 'mdi-file-document-edit',
      type: item.type,
    }))

  return {
    newJobsToday: newJobsToday?.count ?? 0,
    pendingQuestions: pendingQuestions?.count ?? 0,
    inProgress,
    interviewing: pipeline.interviewing,
    pipeline,
    jobsByStatus: Object.fromEntries(jobsByStatus.map(r => [r.status, r.count])),
    totalJobs: jobsByStatus.reduce((sum, r) => sum + r.count, 0),
    totalApplications: appsByStatus.reduce((sum, r) => sum + r.count, 0),
    recentActivity,
  }
})

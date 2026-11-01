import { applications, jobs, questions } from '../db/schema'
import { and, eq, gte, sql } from 'drizzle-orm'

// Counts for the shell and the review dashboard. The review and questions blocks drive the
// "left to decide" count, the nav badges, and the pipeline health strip. The older fields
// (pipeline, recentActivity, and friends) stay so existing callers keep working.
export default defineEventHandler(() => {
  const db = useDb()

  // Local midnight as a UTC SQLite timestamp, the format every *_at column uses.
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayStr = today.toISOString().replace('T', ' ').substring(0, 19)

  const newJobsToday = db.select({ count: sql<number>`count(*)` }).from(jobs).where(gte(jobs.foundAt, todayStr)).get()?.count ?? 0

  const jobsByStatus = db.select({ status: jobs.status, count: sql<number>`count(*)` }).from(jobs).groupBy(jobs.status).all()

  const appsByStatus = db.select({ status: applications.status, count: sql<number>`count(*)` }).from(applications).groupBy(applications.status).all()
  const appCount = (...statuses: string[]) => appsByStatus.filter(r => statuses.includes(r.status)).reduce((n, r) => n + r.count, 0)

  const submittedToday = db.select({ count: sql<number>`count(*)` }).from(applications)
    .where(and(eq(applications.status, 'submitted'), gte(applications.submittedAt, todayStr))).get()?.count ?? 0

  const pendingQuestions = db.select({ count: sql<number>`count(*)` }).from(questions).where(eq(questions.status, 'pending')).get()?.count ?? 0
  const blockingQuestions = db.select({ count: sql<number>`count(*)` }).from(questions)
    .where(and(eq(questions.status, 'pending'), eq(questions.blocking, true))).get()?.count ?? 0

  const pipeline = {
    draft: appCount('draft'),
    ready: appCount('ready'),
    submitted: appCount('submitted'),
    response_received: appCount('response_received'),
    interviewing: appCount('interviewing'),
    rejected: appCount('rejected'),
    offer: appCount('offer'),
  }

  const recentJobs = db.select({ id: jobs.id, title: jobs.title, company: jobs.company, date: jobs.foundAt, status: jobs.status })
    .from(jobs).orderBy(sql`${jobs.foundAt} desc`).limit(5).all()
    .map(j => ({ ...j, type: 'job' as const }))
  const recentApps = db.select({ id: applications.id, date: applications.createdAt, status: applications.status })
    .from(applications).orderBy(sql`${applications.createdAt} desc`).limit(5).all()
    .map(a => ({ ...a, title: '', company: '', type: 'application' as const }))

  const recentActivity = [...recentJobs, ...recentApps]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 10)
    .map(item => ({
      id: item.id,
      text: item.type === 'job' ? `Found: ${item.title} at ${item.company}` : `Application ${item.status}: #${item.id}`,
      date: item.date,
      icon: item.type === 'job' ? 'mdi-briefcase-search' : 'mdi-file-document-edit',
      type: item.type,
    }))

  return {
    review: {
      toDecide: appCount('proposed', 'needs_input'),
      blocked: appCount('needs_input'),
      sending: appCount('approved', 'publishing', 'submitting'),
      needsYou: appCount('submit_failed', 'needs_manual'),
      submittedToday,
      submittedTotal: appCount('submitted'),
    },
    questions: { pending: pendingQuestions, blocking: blockingQuestions },
    newJobsToday,
    pendingQuestions,
    inProgress: pipeline.submitted + pipeline.response_received + pipeline.interviewing,
    interviewing: pipeline.interviewing,
    pipeline,
    jobsByStatus: Object.fromEntries(jobsByStatus.map(r => [r.status, r.count])),
    totalJobs: jobsByStatus.reduce((sum, r) => sum + r.count, 0),
    totalApplications: appsByStatus.reduce((sum, r) => sum + r.count, 0),
    recentActivity,
  }
})

import { sql, type SQL } from 'drizzle-orm'
import { jobs } from '~~/server/db/schema'

// Shared by GET /api/jobs and GET /api/jobs/:id: a job's application, and the key that groups
// postings of the same role at the same company.

/** Application statuses the jobs page files under "In review": being prepared, waiting on a decision, or being sent. */
export const IN_REVIEW_APP_STATUSES = ['preparing', 'needs_input', 'proposed', 'approved', 'publishing', 'submitting', 'submit_failed', 'needs_manual']

/** One column of the job's newest application, as a correlated subquery on jobs.id. */
export function latestApplication(column: 'id' | 'status' | 'form_error'): SQL<any> {
  return sql`(select a.${sql.raw(column)} from applications a where a.job_id = ${jobs.id} order by a.id desc limit 1)`
}

/**
 * The state a job card shows, as a status filter key: in_review while its application is under
 * way, applied once sent, rejected once Devin rejected it, otherwise the job's own status. The
 * jobs page's status filter matches on this, so a filter never returns a card labeled otherwise.
 */
export function jobStateKey(): SQL<string> {
  const app = latestApplication('status')
  const list = (values: string[]) => sql.join(values.map(v => sql`${v}`), sql`, `)
  return sql<string>`case
    when ${app} in (${list(IN_REVIEW_APP_STATUSES)}) then 'in_review'
    when ${app} in (${list(['submitted', 'response_received', 'interviewing', 'offer'])}) then 'applied'
    when ${app} = 'declined' then 'rejected'
    else ${jobs.status} end`
}

/** Same company and same title, ignoring case and outer spaces. */
export function jobGroupKey(): SQL<string> {
  return sql<string>`lower(trim(${jobs.company})) || char(31) || lower(trim(${jobs.title}))`
}

export interface JobApplicationRef {
  id: number
  status: string
  /** Preparation threw before anything was written (form_error starts with prepare_failed). */
  prepareFailed: boolean
}

export function toJobApplication(id: unknown, status: unknown, formError: unknown): JobApplicationRef | null {
  if (id == null || status == null) return null
  return { id: Number(id), status: String(status), prepareFailed: /^prepare_failed/.test(String(formError ?? '')) }
}

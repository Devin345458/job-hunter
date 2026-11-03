import { and, eq } from 'drizzle-orm'
import { jobs } from '~~/server/db/schema'

// Public only through the /sandbox/jobs/<token> page. Returns the posting text for that page.
// ?job=<id> names a seeded sandbox variant (seed-job sets it on the row's URL): its title, company,
// location, and pay come from that row, so a low-pay variant's page says low pay. Without it, or
// for a row that is not a sandbox job, the page shows the default SANDBOX_JOB.
export default defineEventHandler((event) => {
  const query = getQuery(event)
  assertSandboxToken(String(query.token || ''))
  const id = Number(query.job)
  if (Number.isInteger(id) && id > 0) {
    const row = useDb().select().from(jobs).where(and(eq(jobs.id, id), eq(jobs.isSandbox, true))).get()
    if (row) {
      return {
        title: row.title,
        company: row.company,
        location: row.location ?? SANDBOX_JOB.location,
        description: row.postingText || sandboxDescription({ salaryMin: row.salaryMin, salaryMax: row.salaryMax }),
      }
    }
  }
  return SANDBOX_JOB
})

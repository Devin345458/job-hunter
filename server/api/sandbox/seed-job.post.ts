import { eq } from 'drizzle-orm'
import { jobs } from '~~/server/db/schema'

// Behind login. Adds the sandbox posting to the jobs table so the pipeline can run on it
// end to end. Every row it creates is flagged is_sandbox.
// Optional body overrides let tests create variants, e.g. { "remoteType": "onsite", "title": "...", "location": "Austin, TX" }.
// A salary override is written into the posting text too (sandboxDescription), and the row's posting
// URL carries its id (?job=<id>), so the posting page and enrichment read this variant's pay, not
// the default $165,000 to $190,000.
export default defineEventHandler(async (event) => {
  const body = (await readBody<{ title?: string; company?: string; location?: string; remoteType?: 'remote' | 'hybrid' | 'onsite'; salaryMin?: number; salaryMax?: number }>(event).catch(() => null)) || {}
  const token = sandboxToken()
  if (!token) throw createError({ statusCode: 503, statusMessage: 'NUXT_SANDBOX_TOKEN is not set' })
  const base = publicBaseUrl(event)
  const salaryMin = typeof body.salaryMin === 'number' ? body.salaryMin : null
  const salaryMax = typeof body.salaryMax === 'number' ? body.salaryMax : null
  const description = sandboxDescription({ salaryMin, salaryMax })
  const db = useDb()
  const row = db.insert(jobs).values({
    source: 'sandbox',
    sourceId: `sandbox-${Date.now()}`,
    title: body.title?.slice(0, 200) || SANDBOX_JOB.title,
    company: body.company?.slice(0, 200) || SANDBOX_JOB.company,
    location: body.location?.slice(0, 200) || SANDBOX_JOB.location,
    remoteType: body.remoteType && ['remote', 'hybrid', 'onsite'].includes(body.remoteType) ? body.remoteType : 'remote',
    salaryMin,
    salaryMax,
    description,
    postingText: description,
    url: `${base}/sandbox/jobs/${token}`,
    applyUrl: `${base}/sandbox/apply/${token}`,
    atsType: 'sandbox',
    isSandbox: true,
  }).returning().get()
  // The id exists only after the insert. The query keeps the path /sandbox/jobs/<token>, which apply/ats.ts maps to the form.
  return db.update(jobs).set({ url: `${base}/sandbox/jobs/${token}?job=${row.id}` }).where(eq(jobs.id, row.id)).returning().get()
})

import { jobs } from '~~/server/db/schema'

// Behind login. Adds the sandbox posting to the jobs table so the pipeline can run on it
// end to end. Every row it creates is flagged is_sandbox.
// Optional body overrides let tests create variants, e.g. { "remoteType": "onsite", "title": "...", "location": "Austin, TX" }.
export default defineEventHandler(async (event) => {
  const body = (await readBody<{ title?: string; company?: string; location?: string; remoteType?: 'remote' | 'hybrid' | 'onsite'; salaryMin?: number; salaryMax?: number }>(event).catch(() => null)) || {}
  const token = sandboxToken()
  if (!token) throw createError({ statusCode: 503, statusMessage: 'NUXT_SANDBOX_TOKEN is not set' })
  const base = publicBaseUrl(event)
  const row = useDb().insert(jobs).values({
    source: 'sandbox',
    sourceId: `sandbox-${Date.now()}`,
    title: body.title?.slice(0, 200) || SANDBOX_JOB.title,
    company: body.company?.slice(0, 200) || SANDBOX_JOB.company,
    location: body.location?.slice(0, 200) || SANDBOX_JOB.location,
    remoteType: body.remoteType && ['remote', 'hybrid', 'onsite'].includes(body.remoteType) ? body.remoteType : 'remote',
    salaryMin: typeof body.salaryMin === 'number' ? body.salaryMin : null,
    salaryMax: typeof body.salaryMax === 'number' ? body.salaryMax : null,
    description: SANDBOX_JOB.description,
    postingText: SANDBOX_JOB.description,
    url: `${base}/sandbox/jobs/${token}`,
    applyUrl: `${base}/sandbox/apply/${token}`,
    atsType: 'sandbox',
    isSandbox: true,
  }).returning().get()
  return row
})

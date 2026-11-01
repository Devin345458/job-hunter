import { jobs } from '~~/server/db/schema'

// Behind login. Adds the sandbox posting to the jobs table so the pipeline can run on it
// end to end. Every row it creates is flagged is_sandbox.
export default defineEventHandler((event) => {
  const token = sandboxToken()
  if (!token) throw createError({ statusCode: 503, statusMessage: 'NUXT_SANDBOX_TOKEN is not set' })
  const base = publicBaseUrl(event)
  const row = useDb().insert(jobs).values({
    source: 'sandbox',
    sourceId: `sandbox-${Date.now()}`,
    title: SANDBOX_JOB.title,
    company: SANDBOX_JOB.company,
    location: SANDBOX_JOB.location,
    remoteType: 'remote',
    description: SANDBOX_JOB.description,
    postingText: SANDBOX_JOB.description,
    url: `${base}/sandbox/jobs/${token}`,
    applyUrl: `${base}/sandbox/apply/${token}`,
    atsType: 'sandbox',
    isSandbox: true,
  }).returning().get()
  return row
})

import { jsearchAdapter } from '../../utils/job-sources/jsearch'
import { adzunaAdapter } from '../../utils/job-sources/adzuna'
import { remotiveAdapter } from '../../utils/job-sources/remotive'
import { searchConfigs, jobs } from '../../db/schema'
import { eq, and } from 'drizzle-orm'
import type { SearchParams, NormalizedJob, JobSourceAdapter } from '../../utils/job-sources/types'

const adapters: Record<string, JobSourceAdapter> = {
  jsearch: jsearchAdapter,
  adzuna: adzunaAdapter,
  remotive: remotiveAdapter,
}

export default defineTask({
  meta: {
    name: 'jobs:search',
    description: 'Daily job search across all configured sources',
  },
  async run() {
    const db = useDb()
    console.log('[jobs:search] Starting daily job search...')

    // Get active search configs
    const configs = db.select().from(searchConfigs).where(eq(searchConfigs.isActive, true)).all()

    if (configs.length === 0) {
      console.log('[jobs:search] No active search configs found')
      return { result: { found: 0, new: 0 } }
    }

    let totalFound = 0
    let totalNew = 0

    for (const config of configs) {
      const keywords = JSON.parse(config.keywords) as string[]
      const excludedKeywords = config.excludedKeywords ? JSON.parse(config.excludedKeywords) as string[] : undefined
      const locations = config.locations ? JSON.parse(config.locations) as string[] : undefined
      const sources = config.jobSources ? JSON.parse(config.jobSources) as string[] : Object.keys(adapters)

      const params: SearchParams = {
        keywords,
        excludedKeywords,
        locations,
        remoteOnly: config.remoteOnly ?? false,
        salaryMin: config.salaryMin ?? undefined,
        salaryCurrency: config.salaryCurrency ?? 'USD',
      }

      console.log(`[jobs:search] Running config "${config.name}" with sources: ${sources.join(', ')}`)

      // Run all adapters in parallel
      const results = await Promise.allSettled(
        sources
          .filter(s => adapters[s])
          .map(s => adapters[s].search(params)),
      )

      const allJobs: NormalizedJob[] = []
      for (const result of results) {
        if (result.status === 'fulfilled') {
          allJobs.push(...result.value)
        } else {
          console.error('[jobs:search] Adapter error:', result.reason)
        }
      }

      totalFound += allJobs.length
      console.log(`[jobs:search] Found ${allJobs.length} jobs from config "${config.name}"`)

      // Deduplicate and insert
      for (const job of allJobs) {
        // Check if already exists
        const existing = db
          .select({ id: jobs.id })
          .from(jobs)
          .where(and(eq(jobs.source, job.source), eq(jobs.sourceId, job.sourceId)))
          .get()

        if (existing) continue

        try {
          db.insert(jobs).values({
            source: job.source,
            sourceId: job.sourceId,
            title: job.title,
            company: job.company,
            companyUrl: job.companyUrl,
            location: job.location,
            remoteType: job.remoteType,
            salaryMin: job.salaryMin,
            salaryMax: job.salaryMax,
            salaryCurrency: job.salaryCurrency,
            description: job.description,
            url: job.url,
            tags: job.tags ? JSON.stringify(job.tags) : null,
            expiresAt: job.expiresAt,
          }).run()
          totalNew++
        } catch (e) {
          console.error('[jobs:search] Insert error:', e)
        }
      }
    }

    console.log(`[jobs:search] Complete. Found: ${totalFound}, New: ${totalNew}`)
    return { result: { found: totalFound, new: totalNew } }
  },
})

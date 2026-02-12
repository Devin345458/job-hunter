import { eq, and } from 'drizzle-orm'
import { jobs, searchConfigs } from '~~/server/db/schema'
import { jsearchAdapter } from '~~/server/utils/job-sources/jsearch'
import { adzunaAdapter } from '~~/server/utils/job-sources/adzuna'
import { remotiveAdapter } from '~~/server/utils/job-sources/remotive'
import { remoteokAdapter } from '~~/server/utils/job-sources/remoteok'
import { himalayasAdapter } from '~~/server/utils/job-sources/himalayas'
import { jobicyAdapter } from '~~/server/utils/job-sources/jobicy'
import { arbeitnowAdapter } from '~~/server/utils/job-sources/arbeitnow'
import type { NormalizedJob, SearchParams, JobSourceAdapter } from '~~/server/utils/job-sources/types'

const adapters: Record<string, JobSourceAdapter> = {
  jsearch: jsearchAdapter,
  adzuna: adzunaAdapter,
  remotive: remotiveAdapter,
  remoteok: remoteokAdapter,
  himalayas: himalayasAdapter,
  jobicy: jobicyAdapter,
  arbeitnow: arbeitnowAdapter,
}

export default defineEventHandler(async () => {
  const db = useDb()

  try {
    // Get all active search configs
    const configs = await db
      .select()
      .from(searchConfigs)
      .where(eq(searchConfigs.isActive, true))

    if (configs.length === 0) {
      return {
        statusCode: 400,
        statusMessage: 'No active search configurations found. Create a search config first.',
      }
    }

    const allFoundJobs: NormalizedJob[] = []

    for (const config of configs) {
      const searchParams: SearchParams = {
        keywords: JSON.parse(config.keywords),
        excludedKeywords: config.excludedKeywords ? JSON.parse(config.excludedKeywords) : undefined,
        locations: config.locations ? JSON.parse(config.locations) : undefined,
        remoteOnly: config.remoteOnly ?? false,
        salaryMin: config.salaryMin ?? undefined,
        salaryCurrency: config.salaryCurrency ?? 'USD',
      }

      // Determine which adapters to run
      const sourceNames: string[] = config.jobSources
        ? JSON.parse(config.jobSources)
        : Object.keys(adapters)

      // Run all adapters for this config in parallel
      const validAdapters = sourceNames.filter(name => adapters[name])
      const results = await Promise.allSettled(
        validAdapters
          .map(name => adapters[name]!.search(searchParams)),
      )

      for (const result of results) {
        if (result.status === 'fulfilled') {
          allFoundJobs.push(...result.value)
        }
      }
    }

    // Deduplicate by source + sourceId
    const seen = new Set<string>()
    const uniqueJobs = allFoundJobs.filter((job) => {
      const key = `${job.source}:${job.sourceId}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    // Check which jobs already exist in DB
    let newCount = 0
    for (const job of uniqueJobs) {
      const existingResult = await db
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.source, job.source),
            eq(jobs.sourceId, job.sourceId),
          ),
        )

      const existing = existingResult?.[0]
      if (!existing) {
        await db.insert(jobs).values({
          source: job.source,
          sourceId: job.sourceId,
          title: job.title,
          company: job.company,
          companyUrl: job.companyUrl ?? null,
          location: job.location ?? null,
          remoteType: job.remoteType ?? null,
          salaryMin: job.salaryMin ?? null,
          salaryMax: job.salaryMax ?? null,
          salaryCurrency: job.salaryCurrency ?? null,
          description: job.description ?? null,
          url: job.url ?? null,
          tags: job.tags ? JSON.stringify(job.tags) : null,
          expiresAt: job.expiresAt ?? null,
        })
        newCount++
      }
    }

    return {
      found: uniqueJobs.length,
      new: newCount,
    }
  } catch (error: any) {
    console.error('Job search error:', error)
    throw createError({
      statusCode: 500,
      statusMessage: 'Failed to search for jobs',
    })
  }
})

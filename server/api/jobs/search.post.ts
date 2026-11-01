import { runSearch } from '~~/server/utils/job-sources'

// "Run Search Now" on the jobs page. Same code path as the jobs:search task.
export default defineEventHandler(async () => {
  const stats = await runSearch(msg => console.log(`[api/jobs/search] ${msg}`))
  if (stats.configs === 0) {
    throw createError({ statusCode: 400, statusMessage: 'No active search configurations found. Create a search config first.' })
  }
  return {
    message: `Found ${stats.found} listings, ${stats.new} new`,
    jobsFound: stats.new,
    found: stats.found,
    new: stats.new,
    sources: stats.sources,
  }
})

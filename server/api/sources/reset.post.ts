import { ALL_ADAPTERS } from '~~/server/utils/job-sources'
import { resetWatermarks } from '~~/server/utils/job-sources/pull-state'

// POST /api/sources/reset {source?}: "Pull everything again". Clears the watermarks (every source,
// or the one named) so the next search reads each source's whole window again: 14 days from the
// aggregators, every open posting from the boards. Nothing is fetched here.
export default defineEventHandler(async (event) => {
  const body = await readBody<{ source?: unknown } | null>(event).catch(() => null)
  const source = typeof body?.source === 'string' && body.source ? body.source : undefined
  if (source && !ALL_ADAPTERS[source]) {
    throw createError({ statusCode: 400, statusMessage: `Unknown source "${source}"` })
  }
  const reset = resetWatermarks(source)
  return { reset, source: source ?? null }
})

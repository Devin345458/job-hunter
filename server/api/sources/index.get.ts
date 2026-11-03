import type { SourcesStatus } from '#shared/types/sources'
import { sourcesStatus } from '~~/server/utils/job-sources/status'

// GET /api/sources: Settings > Job sources. Per source, the last pull time (watermark) and what
// the last search run found, passed filters, already knew, and stored.
export default defineEventHandler((): SourcesStatus => sourcesStatus())

import type { MemoryStatus } from '#shared/types/memory'

// GET /api/memory/status: Settings > Memory. Off, reachable, or not reachable, from the last
// check this server made (a chat search, a leads run, or Check now).
export default defineEventHandler((): MemoryStatus => memoryStatus())

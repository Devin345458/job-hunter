import type { MemoryStatus } from '#shared/types/memory'

// POST /api/memory/check: Settings > Memory > Check now. Opens and closes one session with the
// memory server (no search), then returns the status.
export default defineEventHandler(async (): Promise<MemoryStatus> => {
  const target = memoryTarget()
  if (target.url) await pingMemory(target)
  return memoryStatus()
})

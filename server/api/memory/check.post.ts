import type { MemoryStatus } from '#shared/types/memory'

// POST /api/memory/check: Settings > Memory > Check now. Opens and closes one session with the
// memory server (no search), then returns the status.
export default defineEventHandler(async (): Promise<MemoryStatus> => {
  const url = memoryUrl()
  if (url) await pingMemory(url)
  return memoryStatus()
})

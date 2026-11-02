import type { MemoryLeadsResponse } from '#shared/types/memory'

// Leads from Devin's past Claude sessions for pending questions (GET /api/memory/leads), fetched
// once per page and shared by every question card and the chat panel. Client only: call load()
// from onMounted.

let inflight: Promise<void> | null = null

export function useMemoryLeads() {
  const byQuestion = useState<MemoryLeadsResponse['byQuestion']>('memory-leads', () => ({}))
  const loaded = useState('memory-leads-loaded', () => false)

  async function load(force = false) {
    if (!import.meta.client || (loaded.value && !force)) return
    if (inflight) return inflight
    inflight = $fetch<MemoryLeadsResponse>('/api/memory/leads')
      .then((res) => {
        byQuestion.value = res.byQuestion
        loaded.value = true
      })
      .catch((e) => {
        // The leads are extra help; the cards work without them.
        console.warn('[memory] could not load leads', e?.data?.statusMessage || e?.message || e)
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  }

  return { byQuestion, loaded, load }
}

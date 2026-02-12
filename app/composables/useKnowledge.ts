import type { InferSelectModel } from 'drizzle-orm'
import type { knowledgeEntries } from '~~/server/db/schema'

export type KnowledgeEntry = InferSelectModel<typeof knowledgeEntries>

export type KnowledgeCategory =
  | 'profile'
  | 'experience'
  | 'skill'
  | 'preference'
  | 'project'
  | 'education'
  | 'personal'

export type KnowledgeSource = 'resume' | 'user_answer' | 'inferred'

export interface KnowledgeEntryInput {
  category: KnowledgeCategory
  key: string
  value: string
  source: KnowledgeSource
}

export function useKnowledge() {
  const entries = ref<KnowledgeEntry[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function fetchEntries(category?: KnowledgeCategory): Promise<KnowledgeEntry[]> {
    loading.value = true
    error.value = null

    try {
      const params: Record<string, string> = {}
      if (category) params.category = category

      const data = await $fetch<KnowledgeEntry[]>('/api/knowledge', { params })
      entries.value = data
      return data
    }
    catch (e: any) {
      error.value = e.data?.message || e.message || 'Failed to fetch knowledge entries'
      throw e
    }
    finally {
      loading.value = false
    }
  }

  async function createEntry(data: KnowledgeEntryInput): Promise<KnowledgeEntry> {
    error.value = null

    try {
      const created = await $fetch<KnowledgeEntry>('/api/knowledge', {
        method: 'POST',
        body: data,
      })
      entries.value.push(created)
      return created
    }
    catch (e: any) {
      error.value = e.data?.message || e.message || 'Failed to create knowledge entry'
      throw e
    }
  }

  async function updateEntry(
    id: number,
    data: Partial<KnowledgeEntryInput>,
  ): Promise<KnowledgeEntry> {
    error.value = null

    try {
      const updated = await $fetch<KnowledgeEntry>(`/api/knowledge/${id}`, {
        method: 'PATCH',
        body: data,
      })

      const idx = entries.value.findIndex(e => e.id === id)
      if (idx !== -1) {
        entries.value[idx] = updated
      }

      return updated
    }
    catch (e: any) {
      error.value = e.data?.message || e.message || 'Failed to update knowledge entry'
      throw e
    }
  }

  return {
    entries,
    loading,
    error,
    fetchEntries,
    createEntry,
    updateEntry,
  }
}

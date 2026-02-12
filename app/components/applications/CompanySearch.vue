<script setup lang="ts">
const emit = defineEmits<{
  search: [query: string]
}>()

const searchQuery = ref('')
const items = ref<string[]>([])
const loading = ref(false)

let debounceTimer: ReturnType<typeof setTimeout> | null = null

async function onSearchInput(val: string | null) {
  const query = val || ''
  searchQuery.value = query

  if (debounceTimer) clearTimeout(debounceTimer)

  if (!query || query.length < 2) {
    items.value = []
    return
  }

  debounceTimer = setTimeout(async () => {
    loading.value = true
    try {
      const data = await $fetch<{ companies: string[] }>('/api/applications', {
        params: { search: query, limit: 10 },
      })
      items.value = [...new Set(
        data.companies || (data as any).applications?.map((a: any) => a.job?.company).filter(Boolean) || [],
      )]
    }
    catch {
      items.value = []
    }
    finally {
      loading.value = false
    }

    emit('search', query)
  }, 350)
}

function onSelect(val: string | null) {
  if (val) {
    emit('search', val)
  }
}
</script>

<template>
  <v-autocomplete
    v-model="searchQuery"
    :items="items"
    :loading="loading"
    label="Search by company"
    prepend-inner-icon="mdi-domain"
    clearable
    hide-details
    hide-no-data
    no-filter
    @update:search="onSearchInput"
    @update:model-value="onSelect"
  />
</template>

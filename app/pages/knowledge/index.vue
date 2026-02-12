<script setup lang="ts">
definePageMeta({ layout: 'default' })

const { entries, loading, error, fetchEntries, createEntry, updateEntry } = useKnowledge()

const categories = [
  { title: 'Profile', value: 'profile', icon: 'mdi-account', color: 'primary' },
  { title: 'Experience', value: 'experience', icon: 'mdi-briefcase', color: 'secondary' },
  { title: 'Skill', value: 'skill', icon: 'mdi-wrench', color: 'accent' },
  { title: 'Preference', value: 'preference', icon: 'mdi-heart', color: 'error' },
  { title: 'Project', value: 'project', icon: 'mdi-rocket-launch', color: 'warning' },
  { title: 'Education', value: 'education', icon: 'mdi-school', color: 'success' },
  { title: 'Personal', value: 'personal', icon: 'mdi-account-heart', color: 'info' },
]

const selectedCategory = ref<string | null>(null)
const searchQuery = ref('')
const showEditor = ref(false)
const editingEntry = ref<any>(null)

const filteredEntries = computed(() => {
  let result = entries.value
  if (selectedCategory.value) {
    result = result.filter(e => e.category === selectedCategory.value)
  }
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase()
    result = result.filter(e =>
      e.key.toLowerCase().includes(q) || e.value.toLowerCase().includes(q),
    )
  }
  return result
})

const groupedEntries = computed(() => {
  const groups: Record<string, typeof entries.value> = {}
  for (const entry of filteredEntries.value) {
    if (!groups[entry.category]) groups[entry.category] = []
    groups[entry.category].push(entry)
  }
  return groups
})

const categoryMeta = (cat: string) => categories.find(c => c.value === cat) || { title: cat, icon: 'mdi-tag', color: 'grey' }

function openEditor(entry?: any) {
  editingEntry.value = entry || null
  showEditor.value = true
}

async function handleSave(data: any) {
  if (data.id) {
    await updateEntry(data.id, { key: data.key, value: data.value, category: data.category })
  } else {
    await createEntry({ category: data.category, key: data.key, value: data.value, source: data.source || 'user_answer' })
  }
  showEditor.value = false
  editingEntry.value = null
  await fetchEntries(selectedCategory.value || undefined)
}

function handleCancel() {
  showEditor.value = false
  editingEntry.value = null
}

onMounted(() => fetchEntries())
</script>

<template>
  <div>
    <div class="d-flex align-center justify-space-between mb-6">
      <h1 class="text-h4 font-weight-bold">Knowledge Base</h1>
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openEditor()">
        Add Entry
      </v-btn>
    </div>

    <!-- Category filter chips -->
    <v-chip-group v-model="selectedCategory" selected-class="text-primary" class="mb-4">
      <v-chip
        :value="null"
        variant="outlined"
        filter
      >
        All
      </v-chip>
      <v-chip
        v-for="cat in categories"
        :key="cat.value"
        :value="cat.value"
        :prepend-icon="cat.icon"
        variant="outlined"
        filter
      >
        {{ cat.title }}
      </v-chip>
    </v-chip-group>

    <!-- Search -->
    <v-text-field
      v-model="searchQuery"
      prepend-inner-icon="mdi-magnify"
      placeholder="Search entries..."
      clearable
      hide-details
      class="mb-6"
    />

    <!-- Loading -->
    <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-4" />

    <!-- Error -->
    <v-alert v-if="error" type="error" class="mb-4">{{ error }}</v-alert>

    <!-- Empty state -->
    <v-card v-if="!loading && filteredEntries.length === 0" variant="outlined" class="text-center pa-12">
      <v-icon icon="mdi-brain" size="80" color="secondary" class="mb-4" />
      <h3 class="text-h6 mb-2">No Knowledge Entries Found</h3>
      <p class="text-body-2 text-medium-emphasis mb-4">
        {{ entries.length === 0
          ? 'Your knowledge base is empty. Add entries manually or run the seed script to import from your resume.'
          : 'No entries match your current filters.'
        }}
      </p>
      <v-btn v-if="entries.length === 0" color="primary" @click="openEditor()">Add First Entry</v-btn>
    </v-card>

    <!-- Grouped entries -->
    <div v-for="(groupEntries, category) in groupedEntries" :key="category" class="mb-6">
      <div class="d-flex align-center mb-3">
        <v-icon :icon="categoryMeta(category).icon" :color="categoryMeta(category).color" size="24" class="mr-2" />
        <h2 class="text-h6 font-weight-medium">{{ categoryMeta(category).title }}</h2>
        <v-chip size="small" class="ml-2">{{ groupEntries.length }}</v-chip>
      </div>

      <v-row>
        <v-col v-for="entry in groupEntries" :key="entry.id" cols="12" md="6" lg="4">
          <v-card variant="outlined" class="entry-card" @click="openEditor(entry)">
            <v-card-title class="text-subtitle-1 font-weight-medium pb-1">
              {{ entry.key }}
            </v-card-title>
            <v-card-text>
              <p class="text-body-2 entry-value">{{ entry.value }}</p>
              <div class="d-flex align-center mt-2">
                <v-chip size="x-small" :color="entry.source === 'resume' ? 'primary' : entry.source === 'inferred' ? 'warning' : 'default'">
                  {{ entry.source }}
                </v-chip>
                <v-spacer />
                <span class="text-caption text-medium-emphasis">{{ new Date(entry.updatedAt).toLocaleDateString() }}</span>
              </div>
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>
    </div>

    <!-- Editor dialog -->
    <v-dialog v-model="showEditor" max-width="600" persistent>
      <KnowledgeEntryEditor
        :entry="editingEntry"
        :categories="categories.map(c => c.value)"
        :dialog="true"
        @save="handleSave"
        @cancel="handleCancel"
      />
    </v-dialog>
  </div>
</template>

<style scoped>
.entry-card {
  cursor: pointer;
  transition: transform 0.15s, box-shadow 0.15s;
}
.entry-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}
.entry-value {
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
  white-space: pre-wrap;
}
</style>

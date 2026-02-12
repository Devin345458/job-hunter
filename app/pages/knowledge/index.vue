<script setup lang="ts">
definePageMeta({ layout: 'default' })

const { entries, loading, error, fetchEntries, createEntry, updateEntry } = useKnowledge()
const snackbar = useSnackbar()

const categories = [
  { title: 'Profile', value: 'profile', icon: 'mdi-account-outline', color: 'primary', description: 'Name, title, summary, contact info' },
  { title: 'Experience', value: 'experience', icon: 'mdi-briefcase-outline', color: 'secondary', description: 'Work history and roles' },
  { title: 'Skill', value: 'skill', icon: 'mdi-wrench-outline', color: 'accent', description: 'Technical and soft skills' },
  { title: 'Preference', value: 'preference', icon: 'mdi-heart-outline', color: 'error', description: 'Work style, culture, salary' },
  { title: 'Project', value: 'project', icon: 'mdi-rocket-launch-outline', color: 'warning', description: 'Notable projects and achievements' },
  { title: 'Education', value: 'education', icon: 'mdi-school-outline', color: 'success', description: 'Degrees and certifications' },
  { title: 'Personal', value: 'personal', icon: 'mdi-account-heart-outline', color: 'info', description: 'Interests and background' },
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

const categoryMeta = (cat: string) => categories.find(c => c.value === cat) || { title: cat, icon: 'mdi-tag', color: 'grey', description: '' }

function openEditor(entry?: any) {
  editingEntry.value = entry || null
  showEditor.value = true
}

async function handleSave(data: any) {
  try {
    if (data.id) {
      await updateEntry(data.id, { key: data.key, value: data.value, category: data.category })
      snackbar.success('Entry updated')
    }
    else {
      await createEntry({ category: data.category, key: data.key, value: data.value, source: data.source || 'user_answer' })
      snackbar.success('Entry added to knowledge base')
    }
    showEditor.value = false
    editingEntry.value = null
    await fetchEntries(selectedCategory.value || undefined)
  }
  catch (e: any) {
    snackbar.error(e.data?.message || 'Failed to save entry')
  }
}

function handleCancel() {
  showEditor.value = false
  editingEntry.value = null
}

onMounted(() => fetchEntries())
</script>

<template>
  <div class="fade-in">
    <!-- Page Header -->
    <div class="d-flex align-center justify-space-between mb-8">
      <div class="page-header">
        <h1 class="text-h4 page-header__title">Knowledge Base</h1>
        <p class="text-body-2 page-header__subtitle">
          Your professional profile in structured form. The AI uses this to match jobs, tailor resumes, and generate interview prep. The more complete your profile, the better the results.
        </p>
      </div>
      <v-btn color="primary" prepend-icon="mdi-plus" @click="openEditor()" class="d-none d-sm-flex">
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
    <v-alert v-if="error" type="error" variant="tonal" closable class="mb-4">
      <v-alert-title class="text-body-2 font-weight-bold">Failed to load knowledge base</v-alert-title>
      <div class="text-body-2 mt-1">{{ error }}</div>
      <div class="mt-3">
        <v-btn variant="outlined" size="small" color="error" prepend-icon="mdi-refresh" @click="fetchEntries()">
          Try Again
        </v-btn>
      </div>
    </v-alert>

    <!-- Empty state -->
    <v-card v-if="!loading && filteredEntries.length === 0" variant="outlined" class="text-center pa-12">
      <v-icon icon="mdi-lightbulb-outline" size="64" class="mb-4" style="opacity: 0.3;" />
      <h3 class="text-h6 mb-2">
        {{ entries.length === 0 ? 'Build Your Profile' : 'No Matching Entries' }}
      </h3>
      <p class="text-body-2 text-medium-emphasis mb-2" style="max-width: 440px; margin: 0 auto;">
        {{ entries.length === 0
          ? 'Your knowledge base powers everything — job matching, resume tailoring, and interview prep. Start by adding entries about your skills, experience, and preferences.'
          : 'No entries match your current search or filter. Try adjusting your criteria.'
        }}
      </p>

      <v-btn v-if="entries.length === 0" color="primary" class="mt-4" @click="openEditor()">
        Add First Entry
      </v-btn>

      <!-- Category guide for new users -->
      <div v-if="entries.length === 0" class="mt-8 pt-6" style="border-top: 1px solid rgba(var(--v-border-color), 0.1);">
        <div class="section-label justify-center" style="max-width: 300px; margin: 0 auto;">
          Categories explained
        </div>
        <v-row justify="center" class="mt-2">
          <v-col v-for="cat in categories" :key="cat.value" cols="12" sm="6" md="3" class="text-center">
            <v-icon :icon="cat.icon" :color="cat.color" size="24" class="mb-1" />
            <div class="text-body-2 font-weight-medium">{{ cat.title }}</div>
            <div class="text-caption text-medium-emphasis">{{ cat.description }}</div>
          </v-col>
        </v-row>
      </div>
    </v-card>

    <!-- Grouped entries -->
    <div v-for="(groupEntries, category) in groupedEntries" :key="category" class="mb-6">
      <div class="d-flex align-center mb-3">
        <v-icon :icon="categoryMeta(category).icon" :color="categoryMeta(category).color" size="20" class="mr-2" />
        <h2 class="text-subtitle-1 font-weight-medium">{{ categoryMeta(category).title }}</h2>
        <v-chip size="x-small" class="ml-2" variant="tonal">{{ groupEntries.length }}</v-chip>
      </div>

      <v-row class="stagger-in">
        <v-col v-for="entry in groupEntries" :key="entry.id" cols="12" md="6" lg="4">
          <v-card variant="outlined" class="entry-card" @click="openEditor(entry)">
            <v-card-title class="text-subtitle-2 font-weight-medium pb-1">
              {{ entry.key }}
            </v-card-title>
            <v-card-text>
              <p class="text-body-2 entry-value">{{ entry.value }}</p>
              <div class="d-flex align-center mt-3">
                <v-chip
                  size="x-small"
                  :color="entry.source === 'resume' ? 'primary' : entry.source === 'inferred' ? 'warning' : 'default'"
                  variant="tonal"
                >
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

    <!-- Mobile FAB for adding entries -->
    <v-btn
      icon
      color="primary"
      size="large"
      position="fixed"
      location="bottom end"
      class="ma-6 d-sm-none"
      @click="openEditor()"
    >
      <v-icon icon="mdi-plus" />
    </v-btn>

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

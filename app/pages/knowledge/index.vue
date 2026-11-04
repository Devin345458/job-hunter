<script setup lang="ts">
import { countText } from '#shared/utils/pay-format'

definePageMeta({ layout: 'default' })

const { entries, loading, error, fetchEntries, createEntry, updateEntry } = useKnowledge()
const snackbar = useSnackbar()

const categories = [
  { title: 'Profile', value: 'profile', icon: 'mdi-account-outline', color: 'primary', description: 'Name, title, summary, contact info' },
  { title: 'Experience', value: 'experience', icon: 'mdi-briefcase-outline', color: 'secondary', description: 'Roles, industries, and kinds of work' },
  { title: 'Skill', value: 'skill', icon: 'mdi-wrench-outline', color: 'accent', description: 'Languages, frameworks, tools, and techniques' },
  { title: 'Preference', value: 'preference', icon: 'mdi-heart-outline', color: 'error', description: 'Work style, culture, salary' },
  { title: 'Project', value: 'project', icon: 'mdi-rocket-launch-outline', color: 'warning', description: 'Notable projects and achievements' },
  { title: 'Education', value: 'education', icon: 'mdi-school-outline', color: 'success', description: 'Degrees and certifications' },
  { title: 'Personal', value: 'personal', icon: 'mdi-account-heart-outline', color: 'info', description: 'Interests and background' },
]

const selectedCategory = ref<string | null>(null)
const searchQuery = ref('')
const showEditor = ref(false)
const editingEntry = ref<any>(null)

/** A new entry starts in the category the list is filtered to (Profile filter, Profile entry). */
const newEntryCategory = computed(() => (selectedCategory.value || 'skill') as KnowledgeCategory)

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
    (groups[entry.category] ??= []).push(entry)
  }
  return groups
})

/** The header's one line about the data. */
const dataLine = computed(() => {
  const n = entries.value.length
  if (!n) return ''
  const answers = entries.value.filter(e => e.source === 'user_answer').length
  return `${countText(n)} entr${n === 1 ? 'y' : 'ies'}, ${countText(answers)} from your answers`
})

function shortDate(value: string) {
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

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
    await fetchEntries((selectedCategory.value || undefined) as KnowledgeCategory | undefined)
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
  <div class="knowledge-page fade-in">
    <div class="page-header page-header--split">
      <div>
        <h1 class="text-h4 page-header__title">Knowledge base</h1>
        <p class="page-header__subtitle">{{ dataLine || '\u00a0' }}</p>
      </div>
      <!-- In the header on every screen. On a phone it used to float over the list cards. -->
      <v-btn color="primary" prepend-icon="mdi-plus" class="knowledge-page__add" @click="openEditor()">
        Add entry
      </v-btn>
    </div>

    <!-- Category filter chips -->
    <div class="knowledge-page__toolbar">
      <v-chip-group v-model="selectedCategory" selected-class="knowledge-page__chip--on" class="knowledge-page__chips" aria-label="Filter by category">
        <v-chip :value="null" variant="outlined">All</v-chip>
        <v-chip v-for="cat in categories" :key="cat.value" :value="cat.value" variant="outlined">{{ cat.title }}</v-chip>
      </v-chip-group>
      <v-text-field
        v-model="searchQuery"
        prepend-inner-icon="mdi-magnify"
        placeholder="Search entries"
        aria-label="Search entries"
        clearable
        hide-details
        class="knowledge-page__search"
      />
    </div>

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
          ? 'Your knowledge base powers everything: job matching, resume tailoring, and interview prep. Start by adding entries about your skills, experience, and preferences.'
          : 'No entries match your current search or filter. Try adjusting your criteria.'
        }}
      </p>

      <v-btn v-if="entries.length === 0" color="primary" class="mt-4" @click="openEditor()">
        Add First Entry
      </v-btn>

      <!-- Category guide for new users -->
      <div v-if="entries.length === 0" class="mt-8 pt-6">
        <h2 class="section-label">Categories</h2>
        <v-row justify="center" class="mt-2">
          <v-col v-for="cat in categories" :key="cat.value" cols="12" sm="6" md="3" class="text-center">
            <div class="text-body-2 font-weight-medium">{{ cat.title }}</div>
            <div class="text-caption text-medium-emphasis">{{ cat.description }}</div>
          </v-col>
        </v-row>
      </div>
    </v-card>

    <!-- Grouped entries: key-value rows, the key in a fixed column so the values start on one edge. -->
    <section v-for="(groupEntries, category) in groupedEntries" :key="category" class="knowledge-page__group" :aria-labelledby="`kb-${category}`">
      <h2 :id="`kb-${category}`" class="knowledge-page__h">
        {{ categoryMeta(category).title }} <span class="knowledge-page__n">{{ countText(groupEntries.length) }}</span>
      </h2>
      <ul class="knowledge-page__rows">
        <li v-for="entry in groupEntries" :key="entry.id">
          <button type="button" class="kv" :aria-label="`Edit ${entry.key}`" @click="openEditor(entry)">
            <span class="kv__key">{{ entry.key }}</span>
            <span class="kv__value">{{ entry.value }}</span>
            <span class="kv__meta">
              <!-- A No answer from /questions. Stored so it is never asked again and never claimed. -->
              <span v-if="(entry as any).negative" class="kv__tag">Never claimed</span>
              <span class="kv__source">{{ entry.source === 'user_answer' ? 'Your answer' : entry.source === 'resume' ? 'Resume' : entry.source === 'inferred' ? 'Inferred' : entry.source }}</span>
              <span class="kv__date">{{ shortDate(entry.updatedAt) }}</span>
            </span>
          </button>
        </li>
      </ul>
    </section>

    <!-- The editor renders its own dialog. Mounting it per open gives a fresh form each time. -->
    <KnowledgeEntryEditor
      v-if="showEditor"
      :entry="editingEntry"
      :default-category="newEntryCategory"
      :dialog="true"
      @save="handleSave"
      @cancel="handleCancel"
    />
  </div>
</template>

<style scoped lang="scss">
.knowledge-page {
  &__add {
    @media (max-width: 599.98px) {
      width: 100%;
    }
  }

  &__toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 16px;
    margin-bottom: 24px;
  }

  &__chips {
    flex: 1 1 520px;
    min-width: 0;
  }

  &__chip--on {
    color: rgb(var(--v-theme-on-surface)) !important;
    background: rgb(var(--v-theme-surface-light));
  }

  &__search {
    flex: 0 1 300px;
    min-width: 220px;
  }

  &__group {
    margin-bottom: 28px;
  }

  &__h {
    margin: 0 0 8px;
    font-size: 1rem;
    font-weight: 600;
  }

  &__n {
    margin-left: 6px;
    font-weight: 400;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__rows {
    list-style: none;
    margin: 0;
    padding: 4px 0;
    border-radius: 16px;
    background: rgb(var(--v-theme-surface));
  }
}

// One entry: key | value | source and date. Rows are split by a rule one step off the card.
.kv {
  width: 100%;
  display: grid;
  grid-template-columns: minmax(160px, 260px) minmax(0, 1fr) auto;
  align-items: baseline;
  column-gap: 20px;
  min-height: 44px;
  padding: 10px 16px;
  color: inherit;
  text-align: left;
  font-size: 0.875rem;
  border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));

  li:first-child > & {
    border-top: 0;
  }

  &:hover {
    background: rgb(var(--v-theme-surface-bright));
  }

  &:focus-visible {
    outline: 2px solid rgb(var(--v-theme-primary));
    outline-offset: -2px;
  }

  &__key {
    font-weight: 500;
    overflow-wrap: anywhere;
  }

  &__value {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.5;
  }

  &__meta {
    display: flex;
    align-items: baseline;
    gap: 10px;
    font-size: 0.75rem;
    white-space: nowrap;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__tag {
    padding: 0 6px;
    border-radius: 6px;
    color: rgb(var(--v-theme-on-surface));
    background: rgb(var(--v-theme-surface-light));
  }

  &__date {
    min-width: 84px;
    text-align: right;
  }

  // Phone: the key over its value, the source and date under them.
  @media (max-width: 699.98px) {
    grid-template-columns: minmax(0, 1fr);
    row-gap: 2px;

    &__meta {
      margin-top: 2px;
    }

    &__date {
      min-width: 0;
      text-align: left;
    }
  }
}
</style>

<script setup lang="ts">
definePageMeta({ layout: 'default' })

interface SearchConfig {
  id: number
  name: string
  keywords: string
  excludedKeywords: string | null
  locations: string | null
  remoteOnly: boolean | null
  salaryMin: number | null
  salaryCurrency: string | null
  jobSources: string | null
  isActive: boolean | null
  createdAt: string
}

const configs = ref<SearchConfig[]>([])
const loading = ref(false)
const saving = ref(false)
const showConfigForm = ref(false)
const editingConfigId = ref<number | null>(null)

const configForm = ref({
  name: '',
  keywords: '',
  excludedKeywords: '',
  locations: '',
  salaryMin: null as number | null,
  remoteOnly: false,
  jobSources: [] as string[],
})

const isEditing = computed(() => editingConfigId.value !== null)
const formTitle = computed(() => isEditing.value ? 'Edit Config' : 'New Config')

const sourceOptions = [
  { title: 'JSearch (RapidAPI)', value: 'jsearch' },
  { title: 'Adzuna', value: 'adzuna' },
  { title: 'Remotive', value: 'remotive' },
  { title: 'RemoteOK', value: 'remoteok' },
  { title: 'Himalayas', value: 'himalayas' },
  { title: 'Jobicy', value: 'jobicy' },
  { title: 'Arbeitnow', value: 'arbeitnow' },
]

function parseJsonArray(val: string | null): string[] {
  if (!val) return []
  try {
    return JSON.parse(val)
  } catch {
    return []
  }
}

async function fetchConfigs() {
  loading.value = true
  try {
    const data = await $fetch<SearchConfig[]>('/api/search-configs')
    configs.value = data
  } catch {
    configs.value = []
  } finally {
    loading.value = false
  }
}

async function toggleConfig(config: SearchConfig) {
  try {
    // Use the create/update endpoint with the id to update
    await $fetch('/api/search-configs', {
      method: 'POST',
      body: {
        id: config.id,
        name: config.name,
        keywords: config.keywords,
        excludedKeywords: config.excludedKeywords,
        locations: config.locations,
        remoteOnly: !config.isActive,
        salaryMin: config.salaryMin,
        salaryCurrency: config.salaryCurrency,
        jobSources: config.jobSources,
        isActive: !config.isActive,
      },
    })
    config.isActive = !config.isActive
  } catch (e) {
    console.error('Failed to toggle config:', e)
  }
}

function resetForm() {
  editingConfigId.value = null
  configForm.value = {
    name: '',
    keywords: '',
    excludedKeywords: '',
    locations: '',
    salaryMin: null,
    remoteOnly: false,
    jobSources: [],
  }
}

function editConfig(config: SearchConfig) {
  editingConfigId.value = config.id
  configForm.value = {
    name: config.name,
    keywords: parseJsonArray(config.keywords).join(', '),
    excludedKeywords: parseJsonArray(config.excludedKeywords).join(', '),
    locations: parseJsonArray(config.locations).join(', '),
    salaryMin: config.salaryMin,
    remoteOnly: config.remoteOnly ?? false,
    jobSources: parseJsonArray(config.jobSources),
  }
  showConfigForm.value = true
}

async function deleteConfig(config: SearchConfig) {
  // Deactivate by setting isActive to false (no delete endpoint exists)
  try {
    await $fetch('/api/search-configs', {
      method: 'POST',
      body: {
        id: config.id,
        name: config.name,
        keywords: config.keywords,
        isActive: false,
      },
    })
    configs.value = configs.value.filter(c => c.id !== config.id)
  } catch (e) {
    console.error('Failed to delete config:', e)
  }
}

async function saveConfig() {
  if (!configForm.value.name || !configForm.value.keywords) return

  saving.value = true
  try {
    const body: Record<string, unknown> = {
      name: configForm.value.name,
      keywords: configForm.value.keywords.split(',').map(k => k.trim()).filter(Boolean),
      excludedKeywords: configForm.value.excludedKeywords
        ? configForm.value.excludedKeywords.split(',').map(k => k.trim()).filter(Boolean)
        : [],
      locations: configForm.value.locations
        ? configForm.value.locations.split(',').map(l => l.trim()).filter(Boolean)
        : [],
      salaryMin: configForm.value.salaryMin,
      remoteOnly: configForm.value.remoteOnly,
      jobSources: configForm.value.jobSources.length ? configForm.value.jobSources : ['jsearch', 'adzuna', 'remotive'],
      isActive: true,
    }

    if (editingConfigId.value) {
      body.id = editingConfigId.value
    }

    const saved = await $fetch<SearchConfig>('/api/search-configs', {
      method: 'POST',
      body,
    })

    if (editingConfigId.value) {
      const idx = configs.value.findIndex(c => c.id === editingConfigId.value)
      if (idx !== -1) configs.value[idx] = saved
    } else {
      configs.value.push(saved)
    }

    showConfigForm.value = false
    resetForm()
  } catch (e) {
    console.error('Failed to save config:', e)
  } finally {
    saving.value = false
  }
}

// Trigger manual search
const searching = ref(false)
async function triggerSearch() {
  searching.value = true
  try {
    const result = await $fetch<{ found: number; new: number }>('/api/jobs/search', { method: 'POST' })
    alert(`Search complete! Found ${result.found} jobs, ${result.new} new.`)
  } catch (e) {
    console.error('Search failed:', e)
    alert('Search failed. Check API key configuration.')
  } finally {
    searching.value = false
  }
}

// Trigger manual scoring
const scoring = ref(false)
async function triggerScoring() {
  scoring.value = true
  try {
    const result = await $fetch<{ scored: number }>('/api/jobs/match', { method: 'POST' })
    alert(`Scoring complete! Scored ${result.scored} jobs.`)
  } catch (e) {
    console.error('Scoring failed:', e)
    alert('Scoring failed. Check Anthropic API key.')
  } finally {
    scoring.value = false
  }
}

onMounted(fetchConfigs)
</script>

<template>
  <div>
    <div class="d-flex align-center justify-space-between mb-6">
      <h1 class="text-h4 font-weight-bold">Settings</h1>
    </div>

    <!-- Manual Actions -->
    <v-card variant="outlined" class="mb-6">
      <v-card-item>
        <v-card-title class="text-subtitle-1 font-weight-medium">
          Manual Actions
        </v-card-title>
        <v-card-subtitle>
          Jobs are searched daily at 6 AM and scored at 7 AM. Use these buttons to trigger manually.
        </v-card-subtitle>
      </v-card-item>
      <v-card-text>
        <div class="d-flex ga-3">
          <v-btn
            color="primary"
            prepend-icon="mdi-magnify"
            :loading="searching"
            @click="triggerSearch"
          >
            Run Job Search Now
          </v-btn>
          <v-btn
            color="secondary"
            prepend-icon="mdi-brain"
            :loading="scoring"
            @click="triggerScoring"
          >
            Score Unscored Jobs
          </v-btn>
        </div>
      </v-card-text>
    </v-card>

    <!-- Search Configurations -->
    <v-card variant="outlined" class="mb-6">
      <v-card-item>
        <v-card-title class="text-subtitle-1 font-weight-medium">
          Search Configurations
        </v-card-title>
        <template #append>
          <v-btn
            color="primary"
            variant="tonal"
            prepend-icon="mdi-plus"
            size="small"
            @click="resetForm(); showConfigForm = !showConfigForm"
          >
            Add Config
          </v-btn>
        </template>
      </v-card-item>

      <v-card-text>
        <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-4" />

        <!-- Config Form (Create / Edit) -->
        <v-expand-transition>
          <v-card v-show="showConfigForm" variant="tonal" color="primary" class="mb-4">
            <v-card-item>
              <v-card-title class="text-subtitle-2">{{ formTitle }}</v-card-title>
            </v-card-item>
            <v-card-text>
              <v-row>
                <v-col cols="12" sm="6">
                  <v-text-field
                    v-model="configForm.name"
                    label="Config name"
                    placeholder="e.g., Senior Frontend Roles"
                    hide-details
                  />
                </v-col>
                <v-col cols="12" sm="6">
                  <v-text-field
                    v-model="configForm.keywords"
                    label="Keywords (comma-separated)"
                    placeholder="e.g., senior developer, staff engineer, tech lead"
                    hide-details
                  />
                </v-col>
                <v-col cols="12" sm="6">
                  <v-text-field
                    v-model="configForm.excludedKeywords"
                    label="Excluded keywords (comma-separated)"
                    placeholder="e.g., junior, intern, .NET"
                    hide-details
                  />
                </v-col>
                <v-col cols="12" sm="6">
                  <v-text-field
                    v-model="configForm.locations"
                    label="Locations (comma-separated)"
                    placeholder="e.g., Remote, United States"
                    hide-details
                  />
                </v-col>
                <v-col cols="12" sm="3">
                  <v-text-field
                    v-model.number="configForm.salaryMin"
                    label="Minimum salary"
                    type="number"
                    prefix="$"
                    hide-details
                  />
                </v-col>
                <v-col cols="12" sm="3" class="d-flex align-center">
                  <v-switch
                    v-model="configForm.remoteOnly"
                    label="Remote only"
                    color="primary"
                    hide-details
                  />
                </v-col>
                <v-col cols="12" sm="6">
                  <v-select
                    v-model="configForm.jobSources"
                    :items="sourceOptions"
                    label="Job sources"
                    multiple
                    chips
                    closable-chips
                    hide-details
                  />
                </v-col>
                <v-col cols="12" class="d-flex justify-end ga-2">
                  <v-btn variant="text" @click="showConfigForm = false; resetForm()">Cancel</v-btn>
                  <v-btn
                    color="primary"
                    :loading="saving"
                    :disabled="!configForm.name || !configForm.keywords"
                    @click="saveConfig"
                  >
                    {{ isEditing ? 'Update Config' : 'Save Config' }}
                  </v-btn>
                </v-col>
              </v-row>
            </v-card-text>
          </v-card>
        </v-expand-transition>

        <!-- Existing Configs -->
        <template v-if="configs.length">
          <v-card v-for="config in configs" :key="config.id" variant="outlined" class="mb-3">
            <v-card-item>
              <template #prepend>
                <v-switch
                  :model-value="config.isActive ?? false"
                  color="success"
                  hide-details
                  density="compact"
                  @update:model-value="toggleConfig(config)"
                />
              </template>
              <v-card-title class="text-subtitle-2">{{ config.name }}</v-card-title>
              <v-card-subtitle>
                Keywords: {{ parseJsonArray(config.keywords).join(', ') }}
              </v-card-subtitle>
              <template #append>
                <v-btn
                  icon="mdi-pencil-outline"
                  variant="text"
                  size="small"
                  @click="editConfig(config)"
                />
                <v-btn
                  icon="mdi-delete-outline"
                  variant="text"
                  color="error"
                  size="small"
                  @click="deleteConfig(config)"
                />
              </template>
            </v-card-item>
            <v-card-text class="pt-0">
              <div class="d-flex flex-wrap ga-2">
                <v-chip
                  v-if="config.excludedKeywords"
                  size="x-small"
                  variant="outlined"
                  prepend-icon="mdi-minus-circle"
                  color="error"
                >
                  Exclude: {{ parseJsonArray(config.excludedKeywords).join(', ') }}
                </v-chip>
                <v-chip
                  v-if="config.locations"
                  size="x-small"
                  variant="outlined"
                  prepend-icon="mdi-map-marker"
                >
                  {{ parseJsonArray(config.locations).join(', ') }}
                </v-chip>
                <v-chip
                  v-if="config.salaryMin"
                  size="x-small"
                  variant="outlined"
                  prepend-icon="mdi-currency-usd"
                >
                  ${{ config.salaryMin.toLocaleString() }}+
                </v-chip>
                <v-chip
                  v-if="config.remoteOnly"
                  size="x-small"
                  variant="outlined"
                  prepend-icon="mdi-earth"
                  color="accent"
                >
                  Remote only
                </v-chip>
                <v-chip
                  v-for="source in parseJsonArray(config.jobSources)"
                  :key="source"
                  size="x-small"
                  variant="tonal"
                  color="secondary"
                >
                  {{ source }}
                </v-chip>
              </div>
            </v-card-text>
          </v-card>
        </template>

        <div v-else-if="!loading" class="text-center pa-8 text-medium-emphasis">
          <v-icon icon="mdi-magnify-plus-outline" size="48" class="mb-3" />
          <p class="text-body-2">No search configurations yet. Add one to start finding jobs.</p>
        </div>
      </v-card-text>
    </v-card>

    <!-- API Keys Info -->
    <v-card variant="outlined">
      <v-card-item>
        <v-card-title class="text-subtitle-1 font-weight-medium">
          API Keys
        </v-card-title>
        <v-card-subtitle>
          API keys are configured as environment variables on the server. Set them in your .env file or Coolify environment settings.
        </v-card-subtitle>
      </v-card-item>
      <v-card-text>
        <v-alert type="info" variant="tonal" class="mb-4">
          <div class="text-body-2">
            Required environment variables:
          </div>
          <ul class="text-body-2 mt-2">
            <li><code>NUXT_ANTHROPIC_API_KEY</code> - For AI job matching and resume tailoring</li>
            <li><code>NUXT_JSEARCH_API_KEY</code> - RapidAPI key for JSearch</li>
            <li><code>NUXT_ADZUNA_APP_ID</code> / <code>NUXT_ADZUNA_API_KEY</code> - Adzuna credentials</li>
          </ul>
        </v-alert>
      </v-card-text>
    </v-card>
  </div>
</template>

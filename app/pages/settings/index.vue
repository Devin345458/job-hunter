<script setup lang="ts">
import { PIPELINE_SCHEDULE_TEXT } from '#shared/utils/schedule'
import { properName } from '#shared/utils/names'

// Chip close buttons are 18px targets, so the phone removes a source through the menu instead.
const isDesktop = useState<boolean>('shell-is-desktop')
definePageMeta({ layout: 'default' })

const snackbar = useSnackbar()

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
const formTitle = computed(() => isEditing.value ? 'Edit Search Config' : 'New Search Config')

const sourceOptions = [
  { title: 'JSearch (RapidAPI)', value: 'jsearch', description: 'Comprehensive aggregator. Needs an API key.' },
  { title: 'Adzuna', value: 'adzuna', description: 'Global job search. Needs an API key.' },
  { title: 'Remotive', value: 'remotive', description: 'Remote jobs. No API key needed.' },
  { title: 'RemoteOK', value: 'remoteok', description: 'Remote tech jobs. No API key needed.' },
  { title: 'Himalayas', value: 'himalayas', description: 'Remote jobs. No API key needed.' },
  { title: 'Jobicy', value: 'jobicy', description: 'Remote jobs. No API key needed.' },
  { title: 'Arbeitnow', value: 'arbeitnow', description: 'European and remote jobs. No API key needed.' },
]

/** The environment variables the API Keys card lists, with what each one is for. */
const API_KEYS = [
  { names: ['NUXT_ANTHROPIC_API_KEY'], text: 'Powers AI job matching and resume tailoring. Required for the core features.' },
  { names: ['NUXT_JSEARCH_API_KEY'], text: 'RapidAPI key for the JSearch source. Optional: other sources work without keys.' },
  { names: ['NUXT_ADZUNA_APP_ID', 'NUXT_ADZUNA_API_KEY'], text: 'Adzuna credentials. Optional: free keys at adzuna.com.' },
  { names: ['NUXT_GITHUB_READ_TOKENS', 'NUXT_GITHUB_READ_TOKEN'], text: 'Read-only GitHub tokens for GitHub evidence (Contents, Metadata, Pull requests read), comma separated, one per owner. Optional: without them it uses NUXT_GITHUB_TOKEN.' },
]

function parseJsonArray(val: string | null): string[] {
  if (!val) return []
  try {
    return JSON.parse(val)
  }
  catch {
    return []
  }
}

async function fetchConfigs() {
  loading.value = true
  try {
    const data = await $fetch<SearchConfig[]>('/api/search-configs')
    configs.value = data
  }
  catch {
    configs.value = []
  }
  finally {
    loading.value = false
  }
}

async function toggleConfig(config: SearchConfig) {
  try {
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
    snackbar.success(config.isActive ? 'Config enabled' : 'Config disabled')
  }
  catch (e) {
    console.error('Failed to toggle config:', e)
    snackbar.error('Failed to update config')
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
    snackbar.success('Config removed')
  }
  catch (e) {
    console.error('Failed to delete config:', e)
    snackbar.error('Failed to remove config')
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
    }
    else {
      configs.value.push(saved)
    }

    showConfigForm.value = false
    resetForm()
    snackbar.success(editingConfigId.value ? 'Config updated' : 'Config created')
  }
  catch (e) {
    console.error('Failed to save config:', e)
    snackbar.error('Failed to save config. Please check your inputs.')
  }
  finally {
    saving.value = false
  }
}

onMounted(fetchConfigs)
</script>

<template>
  <div class="fade-in">
    <!-- Page Header -->
    <div class="page-header mb-8">
      <h1 class="text-h4 page-header__title">Settings</h1>
      <p class="text-body-2 page-header__subtitle">
        Run the pipeline by hand, choose the GitHub repos that can answer skill questions, set what it searches for, and check which API keys it needs. Active searches run {{ PIPELINE_SCHEDULE_TEXT }}.
      </p>
    </div>

    <!-- Pipeline -->
    <v-card id="pipeline" variant="outlined" class="mb-6 settings__pipeline">
      <v-card-item>
        <template #prepend>
          <v-avatar color="primary" variant="tonal" size="36" rounded="lg">
            <v-icon icon="mdi-pipe" size="20" />
          </v-avatar>
        </template>
        <v-card-title class="text-subtitle-1 font-weight-medium">
          Pipeline
        </v-card-title>
        <v-card-subtitle>
          Runs {{ PIPELINE_SCHEDULE_TEXT }}. Start the whole run or any one step here.
        </v-card-subtitle>
      </v-card-item>
      <v-card-text>
        <ReviewPipelinePanel />
      </v-card-text>
    </v-card>

    <!-- GitHub evidence: answers to skill questions from his own commits -->
    <SettingsGithubEvidence id="github-evidence" class="mb-6" />

    <!-- Search Configurations -->
    <v-card variant="outlined" class="mb-6">
      <v-card-item class="settings__configs-head">
        <template #prepend>
          <v-avatar color="accent" variant="tonal" size="36">
            <v-icon icon="mdi-tune-variant" size="20" />
          </v-avatar>
        </template>
        <v-card-title class="text-subtitle-1 font-weight-medium">
          Search Configurations
        </v-card-title>
        <v-card-subtitle>
          Define what jobs to search for. Each active config runs on its own in every scheduled search, {{ PIPELINE_SCHEDULE_TEXT }}.
        </v-card-subtitle>
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
              <v-card-title class="text-subtitle-2 font-weight-bold">{{ formTitle }}</v-card-title>
            </v-card-item>
            <v-card-text>
              <v-row>
                <v-col cols="12" sm="6">
                  <v-text-field
                    v-model="configForm.name"
                    label="Config name"
                    placeholder="e.g., Senior Frontend Roles"
                    hint="A descriptive name to identify this search"
                    persistent-hint
                  />
                </v-col>
                <v-col cols="12" sm="6">
                  <v-text-field
                    v-model="configForm.keywords"
                    label="Keywords (comma-separated)"
                    placeholder="e.g., senior developer, staff engineer, tech lead"
                    hint="Job titles or skills to search for"
                    persistent-hint
                  />
                </v-col>
                <v-col cols="12" sm="6">
                  <v-text-field
                    v-model="configForm.excludedKeywords"
                    label="Excluded keywords (comma-separated)"
                    placeholder="e.g., junior, intern, .NET"
                    hint="Filter out jobs containing these terms"
                    persistent-hint
                  />
                </v-col>
                <v-col cols="12" sm="6">
                  <v-text-field
                    v-model="configForm.locations"
                    label="Locations (comma-separated)"
                    placeholder="e.g., Remote, United States, New York"
                    hint="Leave empty for worldwide results"
                    persistent-hint
                  />
                </v-col>
                <v-col cols="12" sm="3">
                  <v-text-field
                    v-model.number="configForm.salaryMin"
                    label="Minimum salary"
                    type="number"
                    prefix="$"
                    hint="Annual minimum"
                    persistent-hint
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
                    :closable-chips="isDesktop"
                    hint="If none selected, defaults to JSearch, Adzuna, and Remotive"
                    persistent-hint
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
                  :aria-label="`Include ${config.name} in the scheduled searches`"
                  @update:model-value="toggleConfig(config)"
                />
              </template>
              <v-card-title class="text-subtitle-2 font-weight-medium">{{ config.name }}</v-card-title>
              <v-card-subtitle class="text-caption">
                Keywords: {{ parseJsonArray(config.keywords).join(', ') }}
              </v-card-subtitle>
              <template #append>
                <v-btn
                  icon="mdi-pencil-outline"
                  variant="text"
                  size="small"
                  :aria-label="`Edit ${config.name}`"
                  @click="editConfig(config)"
                />
                <v-btn
                  icon="mdi-delete-outline"
                  variant="text"
                  color="error"
                  size="small"
                  :aria-label="`Delete ${config.name}`"
                  @click="deleteConfig(config)"
                />
              </template>
            </v-card-item>
            <v-card-text class="pt-0">
              <div class="d-flex flex-wrap ga-2 settings__config-chips">
                <v-chip
                  v-if="config.excludedKeywords"
                  size="x-small"
                  variant="outlined"
                  prepend-icon="mdi-minus-circle-outline"
                  color="error"
                >
                  Exclude: {{ parseJsonArray(config.excludedKeywords).join(', ') }}
                </v-chip>
                <v-chip
                  v-if="config.locations"
                  size="x-small"
                  variant="outlined"
                  prepend-icon="mdi-map-marker-outline"
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
                  {{ properName(source) }}
                </v-chip>
              </div>
            </v-card-text>
          </v-card>
        </template>

        <div v-else-if="!loading" class="text-center pa-8">
          <v-icon icon="mdi-tune-variant" size="48" class="mb-3" style="opacity: 0.25;" />
          <p class="text-body-2 text-medium-emphasis mb-1">No search configurations yet</p>
          <p class="text-caption text-medium-emphasis">
            Create a search config to define what types of jobs you're looking for. Click "Add Config" above to get started.
          </p>
        </div>
      </v-card-text>
    </v-card>

    <!-- API Keys Info -->
    <v-card variant="outlined">
      <v-card-item>
        <template #prepend>
          <v-avatar color="warning" variant="tonal" size="36">
            <v-icon icon="mdi-key-outline" size="20" />
          </v-avatar>
        </template>
        <v-card-title class="text-subtitle-1 font-weight-medium">
          API Keys
        </v-card-title>
        <v-card-subtitle>
          API keys are set as environment variables on the server. They are never exposed in the browser.
        </v-card-subtitle>
      </v-card-item>
      <v-card-text>
        <v-alert type="info" variant="tonal" class="mb-0">
          <div class="text-body-2 font-weight-medium mb-2">
            Required environment variables:
          </div>
          <!-- A stacked list, not a table: at 390 the alert's icon column left the description
               column one word wide and cut it off on the right. -->
          <dl class="settings__keys">
            <div v-for="k in API_KEYS" :key="k.names.join()" class="settings__key">
              <dt class="settings__key-names">
                <code v-for="n in k.names" :key="n">{{ n }}</code>
              </dt>
              <dd class="settings__key-text">{{ k.text }}</dd>
            </div>
          </dl>
          <div class="text-caption text-medium-emphasis mt-3">
            Set these in your <code>.env</code> file or Coolify environment settings. Free sources (Remotive, RemoteOK, Himalayas, Jobicy, Arbeitnow) work without any API keys.
          </div>
        </v-alert>
      </v-card-text>
    </v-card>
  </div>
</template>

<style scoped lang="scss">
// Card subtitles here are full sentences; let them wrap instead of cutting off on a phone.
.v-card :deep(.v-card-subtitle),
.v-card :deep(.v-card-title) {
  white-space: normal;
  line-height: 1.45;
}

.settings__pipeline {
  scroll-margin-top: 72px;
}

// A long exclude list or location list wraps inside its chip instead of being cut off at 390.
.settings__config-chips :deep(.v-chip) {
  max-width: 100%;
  height: auto;
  min-height: 20px;
  padding-top: 2px;
  padding-bottom: 2px;
  white-space: normal;
}

.settings__keys {
  margin: 0;
}

.settings__key {
  padding: 8px 0;
  border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));

  &:first-child {
    border-top: 0;
    padding-top: 0;
  }
}

.settings__key-names {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  font-size: 0.75rem;
  font-weight: 700;

  code {
    overflow-wrap: anywhere;
  }
}

.settings__key-text {
  margin: 2px 0 0;
  font-size: 0.75rem;
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}

// Phone: Add Config drops under the section title so the title and subtitle get the full width.
@media (max-width: 599.98px) {
  .settings__configs-head {
    grid-template-areas:
      'prepend content'
      '. append';

    :deep(.v-card-item__append) {
      justify-self: start;
      padding-inline-start: 0;
      padding-top: 12px;
    }
  }
}
</style>

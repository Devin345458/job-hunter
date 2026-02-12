<script setup lang="ts">
import type { Job, JobStatus } from '~/composables/useJobs'

definePageMeta({
  layout: 'default',
})

const route = useRoute()
const router = useRouter()
const { getJob, updateJobStatus, loading, error } = useJobs()

const job = ref<Job | null>(null)
const generatingResume = ref(false)

const jobId = computed(() => Number(route.params.id))

const tags = computed(() => {
  if (!job.value?.tags) return []
  try {
    return JSON.parse(job.value.tags) as string[]
  }
  catch {
    return []
  }
})

const salaryDisplay = computed(() => {
  if (!job.value) return ''
  const { salaryMin, salaryMax, salaryCurrency } = job.value
  if (!salaryMin && !salaryMax) return ''

  const c = salaryCurrency || 'USD'
  const symbol = c === 'USD' ? '$' : c
  const fmt = (val: number) => (val >= 1000 ? `${symbol}${Math.round(val / 1000)}K` : `${symbol}${val}`)

  if (salaryMin && salaryMax) return `${fmt(salaryMin)} - ${fmt(salaryMax)}`
  if (salaryMin) return `${fmt(salaryMin)}+`
  if (salaryMax) return `Up to ${fmt(salaryMax)}`
  return ''
})

const matchScoreColor = computed(() => {
  if (!job.value?.matchScore) return 'grey'
  if (job.value.matchScore >= 80) return 'success'
  if (job.value.matchScore >= 60) return 'warning'
  return 'error'
})

async function loadJob() {
  try {
    job.value = await getJob(jobId.value)
  }
  catch {
    // Error handled by composable
  }
}

async function onMarkReady() {
  if (!job.value) return
  try {
    job.value = await updateJobStatus(job.value.id, 'applied' as JobStatus)
  }
  catch {
    // Error handled by composable
  }
}

async function onGenerateResume() {
  if (!job.value) return
  generatingResume.value = true
  try {
    await $fetch(`/api/applications/${job.value.id}`, {
      method: 'POST',
    })
    // Could navigate to the application detail after creation
  }
  catch {
    // Handle error
  }
  finally {
    generatingResume.value = false
  }
}

onMounted(() => {
  loadJob()
})
</script>

<template>
  <div>
    <!-- Back button -->
    <v-btn
      variant="text"
      prepend-icon="mdi-arrow-left"
      class="mb-4"
      @click="router.back()"
    >
      Back to Jobs
    </v-btn>

    <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-4" />

    <v-alert
      v-if="error"
      type="error"
      variant="tonal"
      closable
      class="mb-4"
    >
      {{ error }}
    </v-alert>

    <template v-if="job">
      <v-row>
        <!-- Left Column: Job Description -->
        <v-col cols="12" md="7" lg="8">
          <!-- Job Header -->
          <v-card variant="outlined" class="mb-6">
            <v-card-item>
              <v-card-title class="text-h5 font-weight-bold">
                {{ job.title }}
              </v-card-title>
              <v-card-subtitle class="text-body-1 mt-1">
                {{ job.company }}
              </v-card-subtitle>

              <template #append>
                <v-chip
                  :color="job.status === 'new' ? 'info' : job.status === 'applied' ? 'success' : 'primary'"
                  variant="tonal"
                >
                  {{ job.status }}
                </v-chip>
              </template>
            </v-card-item>

            <v-card-text>
              <div class="d-flex flex-wrap align-center ga-3 mb-4">
                <v-chip
                  v-if="job.location"
                  variant="outlined"
                  prepend-icon="mdi-map-marker"
                  size="small"
                >
                  {{ job.location }}
                </v-chip>

                <v-chip
                  v-if="salaryDisplay"
                  variant="outlined"
                  prepend-icon="mdi-currency-usd"
                  size="small"
                >
                  {{ salaryDisplay }}
                </v-chip>

                <v-chip
                  v-if="job.remoteType"
                  variant="outlined"
                  :prepend-icon="job.remoteType === 'remote' ? 'mdi-earth' : job.remoteType === 'hybrid' ? 'mdi-home-city' : 'mdi-office-building'"
                  size="small"
                  :color="job.remoteType === 'remote' ? 'accent' : undefined"
                >
                  {{ job.remoteType }}
                </v-chip>

                <v-chip
                  v-if="job.source"
                  variant="outlined"
                  prepend-icon="mdi-web"
                  size="small"
                >
                  {{ job.source }}
                </v-chip>
              </div>

              <div v-if="tags.length" class="d-flex flex-wrap ga-1 mb-4">
                <v-chip
                  v-for="tag in tags"
                  :key="tag"
                  size="small"
                  variant="tonal"
                  color="secondary"
                >
                  {{ tag }}
                </v-chip>
              </div>

              <v-btn
                v-if="job.url"
                :href="job.url"
                target="_blank"
                variant="text"
                prepend-icon="mdi-open-in-new"
                color="primary"
                size="small"
              >
                View Original Posting
              </v-btn>
            </v-card-text>
          </v-card>

          <!-- Job Description -->
          <v-card variant="outlined">
            <v-card-item>
              <v-card-title class="text-subtitle-1 font-weight-medium">
                Job Description
              </v-card-title>
            </v-card-item>
            <v-card-text>
              <div
                v-if="job.description"
                class="job-description text-body-2"
                v-html="job.description"
              />
              <p v-else class="text-body-2 text-medium-emphasis">
                No description available.
              </p>
            </v-card-text>
          </v-card>
        </v-col>

        <!-- Right Column: Match Analysis + Resume -->
        <v-col cols="12" md="5" lg="4">
          <!-- Match Score -->
          <v-card variant="outlined" class="mb-4">
            <v-card-item>
              <v-card-title class="text-subtitle-1 font-weight-medium">
                Match Analysis
              </v-card-title>
            </v-card-item>
            <v-card-text>
              <div v-if="job.matchScore != null" class="text-center mb-4">
                <v-progress-circular
                  :model-value="job.matchScore"
                  :size="100"
                  :width="8"
                  :color="matchScoreColor"
                >
                  <span class="text-h4 font-weight-bold">{{ job.matchScore }}</span>
                </v-progress-circular>
                <div class="text-caption text-medium-emphasis mt-2">Match Score</div>
              </div>

              <div v-if="job.matchReasoning" class="text-body-2">
                {{ job.matchReasoning }}
              </div>

              <div
                v-else-if="job.matchScore == null"
                class="text-center text-body-2 text-medium-emphasis pa-4"
              >
                <v-icon icon="mdi-chart-line" size="32" class="mb-2" />
                <p>Match analysis has not been run yet for this job.</p>
              </div>
            </v-card-text>
          </v-card>

          <!-- Actions -->
          <v-card variant="outlined" class="mb-4">
            <v-card-text class="d-flex flex-column ga-3">
              <v-btn
                color="primary"
                block
                prepend-icon="mdi-file-document-edit"
                :loading="generatingResume"
                @click="onGenerateResume"
              >
                Generate Tailored Resume
              </v-btn>

              <v-btn
                color="success"
                variant="tonal"
                block
                prepend-icon="mdi-check-circle"
                :disabled="job.status === 'applied'"
                @click="onMarkReady"
              >
                Mark Ready to Apply
              </v-btn>
            </v-card-text>
          </v-card>

          <!-- Resume Preview Placeholder -->
          <v-card variant="outlined">
            <v-card-item>
              <v-card-title class="text-subtitle-1 font-weight-medium">
                Tailored Resume
              </v-card-title>
            </v-card-item>
            <v-card-text>
              <div class="resume-preview text-center pa-8">
                <v-icon icon="mdi-file-pdf-box" size="48" color="error" class="mb-3" />
                <p class="text-body-2 text-medium-emphasis">
                  Generate a tailored resume to see a preview here.
                </p>
              </div>
            </v-card-text>
          </v-card>
        </v-col>
      </v-row>
    </template>
  </div>
</template>

<style scoped lang="scss">
.job-description {
  line-height: 1.7;

  :deep(ul),
  :deep(ol) {
    padding-left: 1.5rem;
    margin-bottom: 0.75rem;
  }

  :deep(p) {
    margin-bottom: 0.75rem;
  }

  :deep(h1),
  :deep(h2),
  :deep(h3),
  :deep(h4) {
    margin-top: 1rem;
    margin-bottom: 0.5rem;
  }
}

.resume-preview {
  border: 2px dashed rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 8px;
  min-height: 200px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
</style>

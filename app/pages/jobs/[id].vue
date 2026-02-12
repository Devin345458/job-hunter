<script setup lang="ts">
import type { Job, JobStatus } from '~/composables/useJobs'

definePageMeta({
  layout: 'default',
})

const route = useRoute()
const router = useRouter()
const { getJob, updateJobStatus, loading, error } = useJobs()
const snackbar = useSnackbar()

const job = ref<Job | null>(null)
const generatingResume = ref(false)
const resumeError = ref<string | null>(null)
const applicationId = ref<number | null>(null)

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

const matchScoreLabel = computed(() => {
  if (!job.value?.matchScore) return ''
  if (job.value.matchScore >= 80) return 'Strong Match'
  if (job.value.matchScore >= 60) return 'Good Match'
  if (job.value.matchScore >= 40) return 'Partial Match'
  return 'Weak Match'
})

async function loadJob() {
  try {
    job.value = await getJob(jobId.value)

    if (job.value?.status === 'applied') {
      const apps = await $fetch<{ applications: { id: number }[] }>('/api/applications', {
        params: { jobId: jobId.value },
      })
      if (apps.applications?.length) {
        applicationId.value = apps.applications[0].id
      }
    }
  }
  catch {
    // Error handled by composable
  }
}

async function onMarkReady() {
  if (!job.value) return
  try {
    job.value = await updateJobStatus(job.value.id, 'applied' as JobStatus)
    snackbar.success('Job marked as ready to apply')
  }
  catch {
    snackbar.error('Failed to update job status')
  }
}

async function onGenerateResume() {
  if (!job.value) return
  generatingResume.value = true
  resumeError.value = null
  try {
    const application = await $fetch<{ id: number }>(`/api/applications/${job.value.id}`, {
      method: 'POST',
    })
    applicationId.value = application.id
    job.value.status = 'applied'
    snackbar.success('Tailored resume generated successfully', {
      text: 'View Application',
      handler: () => router.push(`/applications/${application.id}`),
    })
  }
  catch (e: any) {
    const msg = e.data?.message || e.message || 'Failed to generate resume'
    resumeError.value = msg
    snackbar.error('Resume generation failed. See details below.')
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
  <div class="fade-in">
    <!-- Back button -->
    <v-btn
      variant="text"
      prepend-icon="mdi-arrow-left"
      class="mb-4"
      size="small"
      @click="router.back()"
    >
      Back to Jobs
    </v-btn>

    <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-4" />

    <!-- Error State -->
    <v-alert
      v-if="error"
      type="error"
      variant="tonal"
      class="mb-4"
    >
      <v-alert-title class="text-body-2 font-weight-bold">Failed to load job</v-alert-title>
      <div class="text-body-2 mt-1">{{ error }}</div>
      <div class="mt-3 d-flex ga-2">
        <v-btn
          variant="outlined"
          size="small"
          color="error"
          prepend-icon="mdi-refresh"
          @click="loadJob()"
        >
          Retry
        </v-btn>
        <v-btn
          variant="text"
          size="small"
          prepend-icon="mdi-arrow-left"
          @click="router.push('/jobs')"
        >
          Back to Jobs
        </v-btn>
      </div>
    </v-alert>

    <template v-if="job">
      <v-row>
        <!-- Left Column: Job Description -->
        <v-col cols="12" md="7" lg="8">
          <!-- Job Header -->
          <v-card variant="outlined" class="mb-6">
            <v-card-item>
              <v-card-title class="text-h5 font-weight-bold" style="letter-spacing: -0.02em;">
                {{ job.title }}
              </v-card-title>
              <v-card-subtitle class="text-body-1 mt-1">
                {{ job.company }}
              </v-card-subtitle>

              <template #append>
                <v-chip
                  :color="job.status === 'new' ? 'info' : job.status === 'applied' ? 'success' : 'primary'"
                  variant="tonal"
                  size="small"
                >
                  {{ job.status }}
                </v-chip>
              </template>
            </v-card-item>

            <v-card-text>
              <div class="d-flex flex-wrap align-center ga-2 mb-4">
                <v-chip
                  v-if="job.location"
                  variant="outlined"
                  prepend-icon="mdi-map-marker-outline"
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
              <div v-else class="text-center pa-8">
                <v-icon icon="mdi-text-box-remove-outline" size="40" class="mb-2" style="opacity: 0.3;" />
                <p class="text-body-2 text-medium-emphasis">
                  No description available for this posting.
                </p>
              </div>
            </v-card-text>
          </v-card>
        </v-col>

        <!-- Right Column: Match Analysis + Actions -->
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
                <div class="text-body-2 font-weight-medium mt-2" :class="`text-${matchScoreColor}`">
                  {{ matchScoreLabel }}
                </div>
              </div>

              <div v-if="job.matchReasoning" class="text-body-2" style="line-height: 1.6;">
                {{ job.matchReasoning }}
              </div>

              <div
                v-else-if="job.matchScore == null"
                class="text-center pa-6"
              >
                <v-icon icon="mdi-chart-line" size="40" class="mb-3" style="opacity: 0.3;" />
                <p class="text-body-2 text-medium-emphasis mb-1">Not scored yet</p>
                <p class="text-caption text-medium-emphasis">
                  This job hasn't been analyzed against your profile. Jobs are scored daily at 7 AM, or you can trigger scoring manually in Settings.
                </p>
              </div>
            </v-card-text>
          </v-card>

          <!-- Actions -->
          <v-card variant="outlined" class="mb-4">
            <v-card-item>
              <v-card-title class="text-subtitle-1 font-weight-medium">
                Actions
              </v-card-title>
            </v-card-item>
            <v-card-text class="d-flex flex-column ga-3">
              <div>
                <v-btn
                  color="primary"
                  block
                  prepend-icon="mdi-file-document-edit-outline"
                  :loading="generatingResume"
                  :disabled="!!applicationId"
                  @click="onGenerateResume"
                >
                  {{ applicationId ? 'Resume Generated' : 'Generate Tailored Resume' }}
                </v-btn>
                <div class="text-caption text-medium-emphasis mt-1 px-1">
                  Uses AI to customize your resume for this specific role based on your knowledge base.
                </div>
              </div>

              <v-btn
                color="success"
                variant="tonal"
                block
                prepend-icon="mdi-check-circle-outline"
                :disabled="job.status === 'applied'"
                @click="onMarkReady"
              >
                {{ job.status === 'applied' ? 'Already Applied' : 'Mark Ready to Apply' }}
              </v-btn>

              <!-- Resume Generation Error -->
              <v-alert
                v-if="resumeError"
                type="error"
                variant="tonal"
                density="compact"
                closable
                class="mt-1"
                @click:close="resumeError = null"
              >
                <div class="text-caption">{{ resumeError }}</div>
                <div class="text-caption text-medium-emphasis mt-1">
                  This usually means the AI response couldn't be parsed. Try again or check that your Anthropic API key is configured in Settings.
                </div>
              </v-alert>
            </v-card-text>
          </v-card>

          <!-- Resume Preview -->
          <v-card variant="outlined">
            <v-card-item>
              <v-card-title class="text-subtitle-1 font-weight-medium">
                Tailored Resume
              </v-card-title>
            </v-card-item>
            <v-card-text>
              <div v-if="applicationId" class="resume-preview text-center pa-8">
                <v-icon icon="mdi-file-check-outline" size="40" color="success" class="mb-3" />
                <p class="text-body-2 font-weight-medium mb-1">Resume ready</p>
                <p class="text-caption text-medium-emphasis mb-4">
                  Your tailored resume has been generated for this role.
                </p>
                <div class="d-flex flex-column ga-2">
                  <v-btn
                    variant="tonal"
                    color="primary"
                    prepend-icon="mdi-download"
                    :href="`/api/resume/pdf/${applicationId}`"
                    target="_blank"
                  >
                    Download PDF
                  </v-btn>
                  <v-btn
                    variant="text"
                    size="small"
                    prepend-icon="mdi-eye-outline"
                    :to="`/applications/${applicationId}`"
                  >
                    View Full Application
                  </v-btn>
                </div>
              </div>
              <div v-else class="resume-preview text-center pa-8">
                <v-icon icon="mdi-file-document-outline" size="40" class="mb-3" style="opacity: 0.25;" />
                <p class="text-body-2 text-medium-emphasis mb-1">
                  No resume yet
                </p>
                <p class="text-caption text-medium-emphasis">
                  Click "Generate Tailored Resume" above to create a customized resume for this position.
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
  border: 1px dashed rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 12px;
  min-height: 200px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
</style>

<script setup lang="ts">
import type { CompensationBreakdown, QuestionView, Requirement, ScoreBreakdown } from '#shared/types/pipeline'
import type { Job, JobStatus } from '~/composables/useJobs'
import { ATS_LABELS } from '~/components/jobs/format'

/** GET /api/jobs/:id adds the parsed pipeline fields to the row. */
type JobDetail = Job & {
  compensation: CompensationBreakdown | null
  score: ScoreBreakdown | null
  requirements: Requirement[]
  postingUrl: string | null
  enrichNotes: string[]
  scoreHistory: Array<{ score: number; skillsScore: number | null; compScore: number | null; learnedAdjustment: number | null; reason: string; computedAt: string }>
  openQuestions: QuestionView[]
}

definePageMeta({
  layout: 'default',
})

const route = useRoute()
const router = useRouter()
const { getJob, updateJobStatus, loading, error } = useJobs()
const snackbar = useSnackbar()

const job = ref<JobDetail | null>(null)
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

  if (salaryMin && salaryMax) return `${fmt(salaryMin)} to ${fmt(salaryMax)}`
  if (salaryMin) return `${fmt(salaryMin)}+`
  if (salaryMax) return `Up to ${fmt(salaryMax)}`
  return ''
})

const atsLabel = computed(() => ATS_LABELS[job.value?.atsType ?? 'unknown'] ?? job.value?.atsType ?? '')

/** Listing HTML when the source gave one; otherwise the posting text the enrichment fetched. */
const hasHtmlDescription = computed(() => !!job.value?.description)

async function loadJob() {
  try {
    job.value = await getJob(jobId.value) as JobDetail

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
    const updated = await updateJobStatus(job.value.id, 'applied' as JobStatus)
    job.value = { ...job.value, ...updated }
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
    // The server answers at once (202) and prepares in the background: resume, cover letter,
    // gap analysis, and the employer form dry run. Nothing is applied for until Devin approves.
    applicationId.value = application.id
    snackbar.success('Preparing the application: resume, cover letter, and form. Follow it on the application page.', {
      text: 'View Application',
      handler: () => router.push(`/applications/${application.id}`),
    })
  }
  catch (e: any) {
    const msg = e.data?.statusMessage || e.data?.message || e.message || 'Could not start preparing the application'
    resumeError.value = msg
    snackbar.error('Could not start preparing the application. See details below.')
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
    <!-- A link, not history.back(): opened from a shared URL, back would leave the app. -->
    <v-btn
      variant="text"
      prepend-icon="mdi-arrow-left"
      class="mb-4"
      size="small"
      to="/jobs"
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
              <v-card-title class="text-h5 font-weight-bold job-detail__title">
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

              <div class="job-detail__links">
                <v-btn
                  v-if="job.applyUrl"
                  :href="job.applyUrl"
                  target="_blank"
                  rel="noopener"
                  color="primary"
                  variant="flat"
                  size="small"
                  prepend-icon="mdi-form-select"
                >
                  Employer application form
                </v-btn>
                <v-chip v-if="job.atsType && job.atsType !== 'unknown'" size="small" variant="tonal" color="secondary" prepend-icon="mdi-domain">
                  {{ atsLabel }}
                </v-chip>
                <v-btn
                  v-if="job.postingUrl || job.url"
                  :href="job.postingUrl || job.url || undefined"
                  target="_blank"
                  rel="noopener"
                  variant="text"
                  prepend-icon="mdi-open-in-new"
                  color="primary"
                  size="small"
                >
                  View posting
                </v-btn>
              </div>

              <v-alert
                v-if="job.enrichedAt && !job.applyUrl"
                type="warning"
                variant="tonal"
                density="compact"
                class="mt-3"
              >
                <div class="text-body-2">
                  No employer application form found.
                </div>
                <div v-for="(note, i) in job.enrichNotes" :key="i" class="text-caption">
                  {{ note }}
                </div>
              </v-alert>
              <v-alert
                v-else-if="job.enrichError"
                type="info"
                variant="tonal"
                density="compact"
                class="mt-3"
              >
                <div class="text-caption">
                  {{ job.enrichError }}
                </div>
              </v-alert>
            </v-card-text>
          </v-card>

          <!-- On phones the actions and the score follow the header instead of sitting below the whole description -->
          <JobsJobActions
            class="mb-6 d-md-none"
            :application-id="applicationId"
            :generating="generatingResume"
            :applied="job.status === 'applied'"
            :resume-error="resumeError"
            @generate="onGenerateResume"
            @mark-ready="onMarkReady"
            @dismiss-error="resumeError = null"
          />

          <JobsScoreBreakdown :score="job.score" :history="job.scoreHistory" :questions="job.openQuestions" class="mb-6 d-md-none" />

          <JobsCompensationBreakdown :compensation="job.compensation" :enriched-at="job.enrichedAt" class="mb-6" />

          <JobsRequirementsList v-if="job.requirements.length" :requirements="job.requirements" class="mb-6" />

          <!-- Job Description -->
          <v-card variant="outlined">
            <v-card-item>
              <v-card-title class="text-subtitle-1 font-weight-medium">
                Job Description
              </v-card-title>
            </v-card-item>
            <v-card-text>
              <div
                v-if="hasHtmlDescription"
                class="job-description text-body-2"
                v-html="job.description"
              />
              <div
                v-else-if="job.postingText"
                class="job-description job-description--plain text-body-2"
              >
                {{ job.postingText }}
              </div>
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
          <JobsScoreBreakdown :score="job.score" :history="job.scoreHistory" :questions="job.openQuestions" class="mb-4 d-none d-md-block" />

          <JobsJobActions
            class="mb-4 d-none d-md-block"
            :application-id="applicationId"
            :generating="generatingResume"
            :applied="job.status === 'applied'"
            :resume-error="resumeError"
            @generate="onGenerateResume"
            @mark-ready="onMarkReady"
            @dismiss-error="resumeError = null"
          />

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
                  Use "Generate Tailored Resume" to create a customized resume for this position.
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
.job-detail__title {
  letter-spacing: -0.02em;
  white-space: normal;
  overflow-wrap: anywhere;
  line-height: 1.25;
}

.job-detail__links {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.job-description {
  line-height: 1.7;
  overflow-wrap: anywhere;

  &--plain {
    white-space: pre-line;
  }

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

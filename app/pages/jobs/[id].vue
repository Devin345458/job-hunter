<script setup lang="ts">
import { properName } from '~/composables/review/format'
import type { CompensationBreakdown, QuestionView, RejectReasonCode, RejectSkillsMode, Requirement, ReviewItem, ScoreBreakdown, SkillClaimSource } from '#shared/types/pipeline'
import type { Job, JobApplicationDetail, JobApplicationRef, JobStatus } from '~/composables/useJobs'
import { ATS_LABELS, jobStateMeta, scoreColor, uniqueTags } from '~/components/jobs/format'
import { plainError } from '#shared/utils/plain-text'
import { payRange } from '#shared/utils/pay-format'

/** GET /api/jobs/:id adds the parsed pipeline fields to the row. */
type JobDetail = Job & {
  compensation: CompensationBreakdown | null
  score: ScoreBreakdown | null
  requirements: Requirement[]
  postingUrl: string | null
  enrichNotes: string[]
  scoreHistory: Array<{ score: number; skillsScore: number | null; compScore: number | null; learnedAdjustment: number | null; reason: string; computedAt: string }>
  openQuestions: QuestionView[]
  application: JobApplicationDetail | null
  /** Other postings of the same role at the same company; the jobs list shows them as one card. */
  otherPostings: Array<{ id: number; location: string | null; status: string; matchScore: number | null; foundAt: string; application: JobApplicationRef | null }>
}

definePageMeta({
  layout: 'default',
})

const route = useRoute()
const router = useRouter()
const { getJob, updateJobStatus, loading, error } = useJobs()
const snackbar = useSnackbar()

const job = ref<JobDetail | null>(null)
/** Which action is running; the card disables the others meanwhile. */
const actionBusy = ref<'prepare' | 'apply' | 'reject' | 'mark' | null>(null)
const actionError = ref<string | null>(null)

const jobId = computed(() => Number(route.params.id))

useHead(() => ({ title: job.value ? `${job.value.title} at ${job.value.company} · Jobs · Job Hunter` : 'Job · Jobs · Job Hunter' }))

const tags = computed(() => uniqueTags(job.value?.tags))
/** The application's state when there is one ("In review"), else the job's own status. */
const state = computed(() => jobStateMeta(job.value?.status, job.value?.application))

const salaryDisplay = computed(() => {
  if (!job.value) return ''
  return payRange(job.value.salaryMin, job.value.salaryMax, job.value.salaryCurrency || 'USD')
})

const atsLabel = computed(() => ATS_LABELS[job.value?.atsType ?? 'unknown'] ?? job.value?.atsType ?? '')

/** Listing HTML when the source gave one; otherwise the posting text the enrichment fetched. */
const hasHtmlDescription = computed(() => !!job.value?.description)

async function loadJob() {
  try {
    job.value = await getJob(jobId.value) as JobDetail
  }
  catch {
    // Error handled by composable
  }
}

function errorText(e: any, fallback: string): string {
  return e?.data?.statusMessage || e?.data?.message || e?.message || fallback
}

/**
 * Job status `applied` closes the job: learning stops rescoring it, answers stop rescoring it, no
 * new gap questions are asked for it, and the jobs list files it under Applied.
 */
async function onMarkApplied() {
  if (!job.value || actionBusy.value) return
  actionBusy.value = 'mark'
  actionError.value = null
  try {
    const updated = await updateJobStatus(job.value.id, 'applied' as JobStatus)
    job.value = { ...job.value, ...updated }
    snackbar.success('Marked applied. This job is no longer scored.')
  }
  catch (e: any) {
    actionError.value = errorText(e, 'Could not mark the job applied')
  }
  finally {
    actionBusy.value = null
  }
}

/** No application yet: POST /api/applications/:jobId, the same Apply a Decide card makes. */
async function onPrepare() {
  if (!job.value || actionBusy.value) return
  actionBusy.value = 'prepare'
  actionError.value = null
  try {
    const application = await $fetch<{ id: number }>(`/api/applications/${job.value.id}`, { method: 'POST' })
    snackbar.success('Preparing the resume, cover letter and form. Nothing is sent until you approve it.', {
      text: 'View application',
      handler: () => router.push(`/applications/${application.id}`),
    })
    await refreshJob()
  }
  catch (e: any) {
    actionError.value = errorText(e, 'Could not start preparing the application')
  }
  finally {
    actionBusy.value = null
  }
}

/** Stage 1 Apply on the job page: POST /api/review/:id/apply, as the Review card does. */
async function onApply() {
  const app = job.value?.application
  if (!app || actionBusy.value) return
  actionBusy.value = 'apply'
  actionError.value = null
  try {
    await $fetch<ReviewItem>(`/api/review/${app.id}/apply`, { method: 'POST' })
    snackbar.success('Preparing the resume, cover letter and form. Nothing is sent until you approve it.', {
      text: 'View application',
      handler: () => router.push(`/applications/${app.id}`),
    })
    await refreshJob()
  }
  catch (e: any) {
    actionError.value = errorText(e, 'Apply failed')
    await refreshJob()
  }
  finally {
    actionBusy.value = null
  }
}

// ── Reject: the Review card's dialog and endpoint. Its skill chips come from the card's item. ──
const rejectOpen = ref(false)
const rejecting = ref(false)
const rejectError = ref<string | null>(null)
const rejectItem = ref<ReviewItem | null>(null)

async function onReject() {
  const app = job.value?.application
  if (!app || actionBusy.value) return
  actionBusy.value = 'reject'
  actionError.value = null
  try {
    rejectItem.value = await $fetch<ReviewItem>(`/api/review/${app.id}`)
    rejectError.value = null
    rejectOpen.value = true
  }
  catch (e: any) {
    actionError.value = errorText(e, 'Could not open Reject')
  }
  finally {
    actionBusy.value = null
  }
}

async function confirmReject(reasonCode: RejectReasonCode, reasonText: string | null, skills: string[], skillsMode: RejectSkillsMode) {
  const app = job.value?.application
  if (!app) return
  rejecting.value = true
  rejectError.value = null
  try {
    const body = skills.length ? { reasonCode, reasonText, skills, skillsMode } : { reasonCode, reasonText }
    await $fetch(`/api/review/${app.id}/reject`, { method: 'POST', body })
    rejectOpen.value = false
    snackbar.success('Rejected. Nothing was sent.')
    await refreshJob()
  }
  catch (e: any) {
    rejectError.value = errorText(e, 'Reject failed')
  }
  finally {
    rejecting.value = false
  }
}

// ── The skill panel: a Missing chip or a requirement that is not Have, tapped ──
const claimOpen = ref(false)
const claimTarget = ref<{ text: string; source: SkillClaimSource } | null>(null)
const preparingAgain = ref(false)

function openClaim(text: string, source: SkillClaimSource) {
  claimTarget.value = { text, source }
  claimOpen.value = true
}

/** The panel saved an answer or the score changed: re-read the job without reloading the page. */
async function refreshJob() {
  try {
    job.value = await $fetch<JobDetail>(`/api/jobs/${jobId.value}`)
  }
  catch {
    // The panel already showed what it saved; the page keeps the version it has.
  }
}

/** Prepare again from the panel: the same POST the review card uses. Nothing runs on its own. */
async function prepareAgain(appId: number) {
  if (preparingAgain.value) return
  preparingAgain.value = true
  try {
    await $fetch(`/api/applications/${appId}/prepare`, { method: 'POST' })
    claimOpen.value = false
    snackbar.success('Preparing the resume, cover letter, and form again. Follow it on the application page.', {
      text: 'View Application',
      handler: () => router.push(`/applications/${appId}`),
    })
    refreshJob()
  }
  catch (e: any) {
    snackbar.error(e?.data?.statusMessage || 'Could not start preparing it again')
  }
  finally {
    preparingAgain.value = false
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
              <v-card-title tag="h1" class="text-h5 job-detail__title">
                {{ job.title }}
              </v-card-title>
              <v-card-subtitle class="text-body-1 mt-1">
                {{ job.company }}
              </v-card-subtitle>

              <template #append>
                <v-chip
                  :color="state.color"
                  variant="tonal"
                  size="small"
                  :to="job.application ? `/applications/${job.application.id}` : undefined"
                  :aria-label="job.application ? `Application: ${state.label}. Open the application` : `Status: ${state.label}`"
                >
                  {{ state.label }}
                </v-chip>
              </template>
            </v-card-item>

            <v-card-text>
              <div class="d-flex flex-wrap align-center ga-2 mb-4">
                <!-- Long multi-office lists wrap to two lines; the whole list is in the tooltip and the accessible name. -->
                <v-chip
                  v-if="job.location && !/^\s*remote\s*$/i.test(job.location)"
                  variant="outlined"
                  prepend-icon="mdi-map-marker-outline"
                  size="small"
                  class="job-detail__location"
                  :title="job.location"
                  :aria-label="`Location: ${job.location}`"
                >
                  <span class="job-detail__location-text">{{ job.location }}</span>
                </v-chip>

                <v-chip
                  v-if="salaryDisplay"
                  variant="outlined"
                  prepend-icon="mdi-currency-usd"
                  size="small"
                >
                  {{ salaryDisplay }} base
                </v-chip>

                <v-chip
                  v-if="job.remoteType"
                  variant="outlined"
                  :prepend-icon="job.remoteType === 'remote' ? 'mdi-earth' : job.remoteType === 'hybrid' ? 'mdi-home-city' : 'mdi-office-building'"
                  size="small"
                  :color="job.remoteType === 'remote' ? 'accent' : undefined"
                >
                  {{ job.remoteType.charAt(0).toUpperCase() + job.remoteType.slice(1) }}
                </v-chip>

                <v-chip
                  v-if="job.source"
                  variant="outlined"
                  prepend-icon="mdi-web"
                  size="small"
                >
                  Found on {{ properName(job.source) }}
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
                  variant="outlined"
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
                  {{ plainError(job.enrichError) }}
                </div>
              </v-alert>

              <!-- The same role posted more than once by the same company; the jobs list shows them as one card. -->
              <div v-if="job.otherPostings?.length" class="job-detail__postings">
                <div class="text-body-2 font-weight-medium">
                  Also posted {{ job.otherPostings.length === 1 ? 'once more' : `${job.otherPostings.length} more times` }}
                </div>
                <ul class="job-detail__postings-list">
                  <li v-for="p in job.otherPostings" :key="p.id">
                    <NuxtLink :to="`/jobs/${p.id}`" class="job-detail__posting">
                      <span class="job-detail__posting-where">{{ p.location || 'No location given' }}</span>
                      <span class="job-detail__posting-meta">
                        <span v-if="p.matchScore != null" :class="`text-${scoreColor(p.matchScore)}`">Match {{ p.matchScore }}</span>
                        <span>{{ jobStateMeta(p.status, p.application).label }}</span>
                      </span>
                    </NuxtLink>
                  </li>
                </ul>
              </div>
            </v-card-text>
          </v-card>

          <!-- On phones the actions and the score follow the header instead of sitting below the whole description -->
          <JobsJobActions
            class="mb-6 d-md-none"
            :job="job"
            :application="job.application"
            :busy="actionBusy"
            :error="actionError"
            @prepare="onPrepare"
            @apply="onApply"
            @reject="onReject"
            @mark-applied="onMarkApplied"
            @dismiss-error="actionError = null"
          />

          <JobsScoreBreakdown :score="job.score" :history="job.scoreHistory" :questions="job.openQuestions" :requirements="job.requirements" class="mb-6 d-md-none" @claim="openClaim" />

          <JobsCompensationBreakdown :compensation="job.compensation" :enriched-at="job.enrichedAt" class="mb-6" />

          <JobsRequirementsList v-if="job.requirements.length" :requirements="job.requirements" class="mb-6" @claim="openClaim" />

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
                class="job-description tap-inline-links text-body-2"
                v-html="job.description"
              />
              <div
                v-else-if="job.postingText"
                class="job-description job-description--plain tap-inline-links text-body-2"
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
          <JobsScoreBreakdown :score="job.score" :history="job.scoreHistory" :questions="job.openQuestions" :requirements="job.requirements" class="mb-4 d-none d-md-block" @claim="openClaim" />

          <JobsJobActions
            class="mb-4 d-none d-md-block"
            :job="job"
            :application="job.application"
            :busy="actionBusy"
            :error="actionError"
            @prepare="onPrepare"
            @apply="onApply"
            @reject="onReject"
            @mark-applied="onMarkApplied"
            @dismiss-error="actionError = null"
          />
        </v-col>
      </v-row>

      <ReviewRejectDialog
        v-if="rejectItem"
        v-model="rejectOpen"
        :title="job.title"
        :company="job.company"
        :skill-options="rejectItem.rejectSkillOptions"
        :is-sandbox="rejectItem.isSandbox"
        :before-materials="rejectItem.status === 'to_decide'"
        :busy="rejecting"
        :error="rejectError"
        @confirm="confirmReject"
      />

      <SkillsClaimDialog
        v-model="claimOpen"
        :job-id="job.id"
        :application-id="job.application?.id ?? null"
        :target="claimTarget"
        :job="{ title: job.title, company: job.company }"
        :preparing="preparingAgain"
        @changed="refreshJob"
        @prepare="prepareAgain"
      />
    </template>
  </div>
</template>

<style scoped lang="scss">
.job-detail__postings {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}

.job-detail__postings-list {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
}

// Each posting is a 44px row link: location on the left, its score and state on the right.
.job-detail__posting {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 2px 12px;
  min-height: 44px;
  padding: 6px 8px;
  margin: 0 -8px;
  border-radius: 8px;
  color: inherit;
  text-decoration: none;
  font-size: 0.875rem;

  &:hover {
    background: rgba(var(--v-theme-on-surface), 0.05);
  }

  &:focus-visible {
    outline: 2px solid rgb(var(--v-theme-primary));
    outline-offset: -2px;
  }
}

.job-detail__posting-where {
  color: rgb(var(--v-theme-primary));
  overflow-wrap: anywhere;
}

.job-detail__posting-meta {
  display: inline-flex;
  gap: 12px;
  font-size: 0.8125rem;
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}

.job-detail__title {
  letter-spacing: -0.02em;
  white-space: normal;
  overflow-wrap: anywhere;
  line-height: 1.25;
}

// The chip grows to two lines instead of clipping at the card edge.
.job-detail__location {
  height: auto !important;
  min-height: 24px;
  max-width: 100%;
  padding-block: 3px;

  :deep(.v-chip__content) {
    min-width: 0;
  }
}

.job-detail__location-text {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
  white-space: normal;
  overflow-wrap: anywhere;
  line-height: 1.35;
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
</style>

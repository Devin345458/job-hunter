<script setup lang="ts">
import type { ApplicationWithJob, ApplicationStatus } from '~/composables/useApplications'

definePageMeta({
  layout: 'default',
})

const route = useRoute()
const router = useRouter()
const { getApplication, updateApplication, loading, error } = useApplications()
const snackbar = useSnackbar()

const application = ref<ApplicationWithJob | null>(null)
const activeTab = ref('resume')
const notes = ref('')
const savingNotes = ref(false)
const questions = ref<{ id: number; question: string; answer: string | null; category: string | null }[]>([])

const applicationId = computed(() => Number(route.params.id))

const statusColors: Record<ApplicationStatus, string> = {
  draft: 'grey',
  ready: 'info',
  submitted: 'primary',
  response_received: 'accent',
  interviewing: 'warning',
  rejected: 'error',
  offer: 'success',
}

const statusLabels: Record<ApplicationStatus, string> = {
  draft: 'Draft',
  ready: 'Ready',
  submitted: 'Submitted',
  response_received: 'Response',
  interviewing: 'Interviewing',
  rejected: 'Rejected',
  offer: 'Offer',
}

interface TimelineEvent {
  title: string
  subtitle: string
  icon: string
  color: string
  date: string
}

const timeline = computed<TimelineEvent[]>(() => {
  if (!application.value) return []

  const events: TimelineEvent[] = []

  if (application.value.job?.foundAt) {
    events.push({
      title: 'Job Found',
      subtitle: `Discovered on ${application.value.job.source || 'job board'}`,
      icon: 'mdi-magnify',
      color: 'info',
      date: application.value.job.foundAt,
    })
  }

  events.push({
    title: 'Application Created',
    subtitle: 'Resume tailoring started',
    icon: 'mdi-file-document-edit',
    color: 'primary',
    date: application.value.createdAt,
  })

  if (application.value.submittedAt) {
    events.push({
      title: 'Application Submitted',
      subtitle: 'Sent to company',
      icon: 'mdi-send',
      color: 'success',
      date: application.value.submittedAt,
    })
  }

  if (application.value.responseAt) {
    events.push({
      title: 'Response Received',
      subtitle: 'Company responded',
      icon: 'mdi-email-open',
      color: 'accent',
      date: application.value.responseAt,
    })
  }

  return events.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
})

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

async function downloadPdf() {
  if (!application.value) return
  const url = `/api/resume/pdf/${application.value.id}`
  window.open(url, '_blank')
}

async function loadApplication() {
  try {
    application.value = await getApplication(applicationId.value)
    notes.value = application.value.notes || ''
  }
  catch {
    // Error handled by composable
  }
}

async function loadQuestions() {
  try {
    const data = await $fetch<{ questions: typeof questions.value }>('/api/questions', {
      params: { applicationId: applicationId.value },
    })
    questions.value = data.questions || []
  }
  catch {
    questions.value = []
  }
}

async function saveNotes() {
  if (!application.value) return

  savingNotes.value = true
  try {
    application.value = await updateApplication(application.value.id, {
      notes: notes.value,
    })
    snackbar.success('Notes saved')
  }
  catch {
    snackbar.error('Failed to save notes. Please try again.')
  }
  finally {
    savingNotes.value = false
  }
}

onMounted(() => {
  loadApplication()
  loadQuestions()
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
      Back to Applications
    </v-btn>

    <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-4" />

    <v-alert
      v-if="error"
      type="error"
      variant="tonal"
      class="mb-4"
    >
      <v-alert-title class="text-body-2 font-weight-bold">Failed to load application</v-alert-title>
      <div class="text-body-2 mt-1">{{ error }}</div>
      <div class="mt-3 d-flex ga-2">
        <v-btn
          variant="outlined"
          size="small"
          color="error"
          prepend-icon="mdi-refresh"
          @click="loadApplication()"
        >
          Retry
        </v-btn>
        <v-btn
          variant="text"
          size="small"
          prepend-icon="mdi-arrow-left"
          @click="router.push('/applications')"
        >
          Back to Applications
        </v-btn>
      </div>
    </v-alert>

    <template v-if="application">
      <!-- Company Header -->
      <v-card variant="outlined" class="mb-6">
        <v-card-item>
          <template #prepend>
            <v-avatar color="primary" variant="tonal" size="48">
              <v-icon icon="mdi-domain" />
            </v-avatar>
          </template>

          <v-card-title class="text-h5 font-weight-bold" style="letter-spacing: -0.02em;">
            {{ application.job?.company || 'Unknown Company' }}
          </v-card-title>
          <v-card-subtitle class="text-body-1">
            {{ application.job?.title || 'Unknown Role' }}
          </v-card-subtitle>

          <template #append>
            <v-chip
              :color="statusColors[application.status as ApplicationStatus] || 'grey'"
              variant="tonal"
            >
              {{ statusLabels[application.status as ApplicationStatus] || application.status }}
            </v-chip>
          </template>
        </v-card-item>

        <v-card-text class="d-flex flex-wrap ga-3 pt-0">
          <v-chip
            v-if="application.job?.companyUrl"
            :href="application.job.companyUrl"
            target="_blank"
            variant="outlined"
            prepend-icon="mdi-open-in-new"
            size="small"
          >
            Company Website
          </v-chip>

          <v-chip
            v-if="application.job?.location"
            variant="outlined"
            prepend-icon="mdi-map-marker-outline"
            size="small"
          >
            {{ application.job.location }}
          </v-chip>

          <v-chip
            v-if="application.job?.matchScore != null"
            variant="outlined"
            prepend-icon="mdi-chart-line"
            size="small"
          >
            Match: {{ application.job.matchScore }}%
          </v-chip>
        </v-card-text>
      </v-card>

      <!-- Content Tabs -->
      <v-card variant="outlined">
        <v-tabs
          v-model="activeTab"
          color="primary"
          bg-color="surface"
        >
          <v-tab value="resume" prepend-icon="mdi-file-document-outline">
            Resume
          </v-tab>
          <v-tab value="cover-letter" prepend-icon="mdi-email-edit-outline">
            Cover Letter
          </v-tab>
          <v-tab value="tailoring" prepend-icon="mdi-auto-fix">
            Tailoring Notes
          </v-tab>
          <v-tab value="timeline" prepend-icon="mdi-timeline-clock-outline">
            Timeline
          </v-tab>
          <v-tab value="notes" prepend-icon="mdi-note-edit-outline">
            Notes
          </v-tab>
          <v-tab value="qa" prepend-icon="mdi-chat-processing-outline">
            Q&A
          </v-tab>
        </v-tabs>

        <v-divider />

        <v-tabs-window v-model="activeTab">
          <!-- Resume Tab -->
          <v-tabs-window-item value="resume">
            <v-card-text>
              <div v-if="application.tailoredResumeJson" class="resume-preview pa-6">
                <v-icon icon="mdi-file-check-outline" size="40" color="success" class="mb-3" />
                <p class="text-body-2 font-weight-medium mb-1">Tailored resume ready</p>
                <p class="text-caption text-medium-emphasis mb-4">
                  Your resume has been customized for this specific role.
                </p>
                <v-btn
                  variant="tonal"
                  color="primary"
                  prepend-icon="mdi-download"
                  @click="downloadPdf"
                >
                  Download PDF
                </v-btn>
              </div>
              <div v-else class="resume-preview pa-8 text-center">
                <v-icon icon="mdi-file-document-outline" size="48" class="mb-3" style="opacity: 0.25;" />
                <h3 class="text-h6 mb-2">No Resume Generated</h3>
                <p class="text-body-2 text-medium-emphasis mb-1">
                  A tailored resume hasn't been generated for this application yet.
                </p>
                <p class="text-caption text-medium-emphasis mb-4">
                  Go to the job detail page to generate one. The AI will customize your resume to match the job requirements.
                </p>
                <v-btn
                  v-if="application.jobId"
                  variant="tonal"
                  color="primary"
                  prepend-icon="mdi-file-document-edit-outline"
                  :to="`/jobs/${application.jobId}`"
                >
                  Go to Job
                </v-btn>
              </div>
            </v-card-text>
          </v-tabs-window-item>

          <!-- Cover Letter Tab -->
          <v-tabs-window-item value="cover-letter">
            <v-card-text>
              <div v-if="application.coverLetter" class="cover-letter">
                <div class="text-body-1" style="white-space: pre-wrap;">{{ application.coverLetter }}</div>
              </div>
              <div v-else class="text-center pa-8">
                <v-icon icon="mdi-email-edit-outline" size="40" class="mb-3" style="opacity: 0.25;" />
                <p class="text-body-2 text-medium-emphasis mb-1">No cover letter yet</p>
                <p class="text-caption text-medium-emphasis">
                  A cover letter will be generated along with your tailored resume when you apply through the job detail page.
                </p>
              </div>
            </v-card-text>
          </v-tabs-window-item>

          <!-- Tailoring Notes Tab -->
          <v-tabs-window-item value="tailoring">
            <v-card-text>
              <div v-if="application.tailoringNotes">
                <div class="info-banner mb-4">
                  <div class="d-flex align-start ga-2">
                    <v-icon icon="mdi-information-outline" size="16" class="mt-1 info-banner__icon" />
                    <div class="info-banner__text">
                      These notes explain how the AI customized your resume for this role — what was emphasized, reworded, or restructured.
                    </div>
                  </div>
                </div>
                <div class="text-body-2" style="white-space: pre-wrap; line-height: 1.7;">
                  {{ application.tailoringNotes }}
                </div>
              </div>
              <div v-else class="text-center pa-8">
                <v-icon icon="mdi-auto-fix" size="40" class="mb-3" style="opacity: 0.25;" />
                <p class="text-body-2 text-medium-emphasis mb-1">No tailoring notes</p>
                <p class="text-caption text-medium-emphasis">
                  When a resume is generated, the AI provides notes explaining what it emphasized and why.
                </p>
              </div>
            </v-card-text>
          </v-tabs-window-item>

          <!-- Timeline Tab -->
          <v-tabs-window-item value="timeline">
            <v-card-text>
              <v-timeline
                v-if="timeline.length"
                side="end"
                density="compact"
                truncate-line="both"
              >
                <v-timeline-item
                  v-for="(event, idx) in timeline"
                  :key="idx"
                  :dot-color="event.color"
                  :icon="event.icon"
                  size="small"
                >
                  <div class="mb-1">
                    <strong class="text-body-2">{{ event.title }}</strong>
                  </div>
                  <div class="text-caption text-medium-emphasis">
                    {{ event.subtitle }}
                  </div>
                  <div class="text-caption text-medium-emphasis mt-1">
                    {{ formatDate(event.date) }}
                  </div>
                </v-timeline-item>
              </v-timeline>

              <div v-else class="text-center pa-8">
                <v-icon icon="mdi-timeline-clock-outline" size="40" class="mb-3" style="opacity: 0.25;" />
                <p class="text-body-2 text-medium-emphasis mb-1">No timeline events yet</p>
                <p class="text-caption text-medium-emphasis">
                  Events are added automatically as your application progresses through each stage.
                </p>
              </div>
            </v-card-text>
          </v-tabs-window-item>

          <!-- Notes Tab -->
          <v-tabs-window-item value="notes">
            <v-card-text>
              <div class="info-banner mb-4">
                <div class="d-flex align-start ga-2">
                  <v-icon icon="mdi-information-outline" size="16" class="mt-1 info-banner__icon" />
                  <div class="info-banner__text">
                    Use this space for personal notes about the application — interview prep, follow-up reminders, contact info, or anything else you want to track.
                  </div>
                </div>
              </div>
              <v-textarea
                v-model="notes"
                label="Your notes"
                placeholder="Add any personal notes about this application..."
                rows="8"
                auto-grow
                hide-details
                class="mb-4"
              />
              <div class="d-flex justify-end">
                <v-btn
                  color="primary"
                  prepend-icon="mdi-content-save"
                  :loading="savingNotes"
                  @click="saveNotes"
                >
                  Save Notes
                </v-btn>
              </div>
            </v-card-text>
          </v-tabs-window-item>

          <!-- Q&A Tab -->
          <v-tabs-window-item value="qa">
            <v-card-text>
              <template v-if="questions.length">
                <div class="info-banner mb-4">
                  <div class="d-flex align-start ga-2">
                    <v-icon icon="mdi-information-outline" size="16" class="mt-1 info-banner__icon" />
                    <div class="info-banner__text">
                      These interview questions were generated by AI based on the job requirements and any gaps identified in your profile. Prepare answers for each to strengthen your interview performance.
                    </div>
                  </div>
                </div>
                <v-card
                  v-for="q in questions"
                  :key="q.id"
                  variant="tonal"
                  class="mb-3"
                >
                  <v-card-item>
                    <template #prepend>
                      <v-icon
                        :icon="q.answer ? 'mdi-check-circle' : 'mdi-help-circle-outline'"
                        :color="q.answer ? 'success' : 'warning'"
                        size="20"
                      />
                    </template>
                    <v-card-title class="text-body-2 font-weight-medium">
                      {{ q.question }}
                    </v-card-title>
                    <v-card-subtitle v-if="q.category" class="text-caption">
                      {{ q.category }}
                    </v-card-subtitle>
                  </v-card-item>
                  <v-card-text v-if="q.answer" class="pt-0">
                    <div class="text-body-2 bg-surface pa-3 rounded-lg">
                      {{ q.answer }}
                    </div>
                  </v-card-text>
                </v-card>
              </template>

              <div v-else class="text-center pa-8">
                <v-icon icon="mdi-chat-processing-outline" size="40" class="mb-3" style="opacity: 0.25;" />
                <p class="text-body-2 text-medium-emphasis mb-1">No interview questions yet</p>
                <p class="text-caption text-medium-emphasis">
                  Interview questions are generated when the AI identifies gaps between your profile and the job requirements during resume tailoring.
                </p>
              </div>
            </v-card-text>
          </v-tabs-window-item>
        </v-tabs-window>
      </v-card>
    </template>
  </div>
</template>

<style scoped lang="scss">
.resume-preview {
  border: 1px dashed rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 12px;
  min-height: 300px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.cover-letter {
  max-width: 700px;
  line-height: 1.7;
}
</style>

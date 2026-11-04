<script setup lang="ts">
import type { JobApplicationDetail } from '~/composables/useJobs'
import { parseTime } from '~/composables/review/format'

// The job page's actions, driven by the application's real state. Since Decide first, every job
// scoring 70 or more has a to_decide application row with no resume, so "an application exists"
// says nothing about a resume. Decide-stage jobs get Apply and Reject through the same endpoints
// and dialog as the Review card; prepared ones link to their Send card, where Approve lives.
// The page renders this twice (under the header on a phone, in the right column on desktop).
const props = defineProps<{
  job: { id: number; company: string; status: string }
  application: JobApplicationDetail | null
  busy: 'prepare' | 'apply' | 'reject' | 'mark' | null
  error: string | null
}>()

const emit = defineEmits<{
  prepare: []
  apply: []
  reject: []
  markApplied: []
  dismissError: []
}>()

type Stage = 'none' | 'marked' | 'decide' | 'preparing' | 'send' | 'sending' | 'sent' | 'declined' | 'other'

const SEND = ['proposed', 'needs_input', 'submit_failed', 'needs_manual']
const SENDING = ['approved', 'publishing', 'submitting']
const SENT = ['submitted', 'response_received', 'interviewing', 'offer', 'rejected', 'no_response']

const stage = computed<Stage>(() => {
  const a = props.application
  if (!a) return props.job.status === 'applied' ? 'marked' : 'none'
  if (a.status === 'to_decide') return 'decide'
  if (a.status === 'preparing') return 'preparing'
  if (SEND.includes(a.status)) return 'send'
  if (SENDING.includes(a.status)) return 'sending'
  if (SENT.includes(a.status)) return 'sent'
  if (a.status === 'declined') return 'declined'
  return 'other'
})

const sentOn = computed(() => {
  const d = parseTime(props.application?.submittedAt)
  return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''
})

const resumeLine = computed(() => {
  if (props.application?.hasResume) return ''
  switch (stage.value) {
    case 'none': return 'No resume yet. Preparing the application writes one for this role.'
    case 'decide': return 'No resume yet. Apply writes one, with the cover letter and the form answers.'
    case 'preparing': return 'The resume is being written now.'
    default: return 'No tailored resume was written for this application.'
  }
})
</script>

<template>
  <v-card variant="outlined" class="ja">
    <v-card-item>
      <v-card-title class="text-subtitle-1 font-weight-medium">
        Your application
      </v-card-title>
    </v-card-item>
    <v-card-text class="d-flex flex-column ga-3">
      <!-- No application yet: the same Apply as a Decide card (records the choice, queues the preparation). -->
      <template v-if="stage === 'none'">
        <v-btn color="primary" block :loading="busy === 'prepare'" :disabled="!!busy" @click="emit('prepare')">
          Prepare application
        </v-btn>
        <p class="ja__note">
          Writes the resume, cover letter and form answers. Nothing goes to {{ job.company }} until you approve it.
        </p>
        <v-btn variant="text" block :loading="busy === 'mark'" :disabled="!!busy" @click="emit('markApplied')">
          I applied on my own
        </v-btn>
        <p class="ja__note">
          Marks the job applied and stops scoring it. Nothing is sent.
        </p>
      </template>

      <p v-else-if="stage === 'marked'" class="ja__state">
        You marked this job applied on your own. It is no longer scored.
      </p>

      <!-- Stage 1: the Decide card's two choices, on the same endpoints. -->
      <template v-else-if="stage === 'decide' && application">
        <div class="ja__row">
          <v-btn color="primary" class="flex-grow-1" :loading="busy === 'apply'" :disabled="!!busy" @click="emit('apply')">
            Apply
          </v-btn>
          <v-btn variant="outlined" class="flex-grow-1" :loading="busy === 'reject'" :disabled="!!busy" @click="emit('reject')">
            Reject
          </v-btn>
        </div>
        <p class="ja__note">
          Apply writes the resume, cover letter and form answers. Nothing goes to {{ job.company }} until you approve it.
        </p>
        <v-btn variant="text" block :to="`/review/${application.id}`">
          Open its review card
        </v-btn>
      </template>

      <template v-else-if="stage === 'preparing' && application">
        <p class="ja__state">
          Preparing{{ application.statusDetail ? `: ${application.statusDetail}` : '' }}
        </p>
        <v-btn variant="outlined" block :to="`/applications/${application.id}`">
          Open the application
        </v-btn>
      </template>

      <!-- Prepared: Approve stays on the Send card, where the materials are read before sending. -->
      <template v-else-if="stage === 'send' && application">
        <p class="ja__state">
          {{ application.status === 'needs_input' ? 'Prepared. It needs your answers before it can be sent.'
            : application.status === 'submit_failed' ? 'The submit failed. Check it on the Send card.'
              : application.status === 'needs_manual' ? (application.prepareFailed ? 'Preparation failed.' : 'Prepared. Submit it by hand.')
                : 'Prepared and ready to send.' }}
        </p>
        <v-btn color="primary" block :to="`/review/${application.id}`">
          Open the Send card
        </v-btn>
      </template>

      <template v-else-if="stage === 'sending' && application">
        <p class="ja__state">Sending now.</p>
        <v-btn variant="outlined" block :to="`/applications/${application.id}`">
          Open the application
        </v-btn>
      </template>

      <template v-else-if="(stage === 'sent' || stage === 'declined' || stage === 'other') && application">
        <p class="ja__state">
          {{ stage === 'sent' ? `Applied${sentOn ? ` on ${sentOn}` : ''}.` : stage === 'declined' ? 'You rejected this job. Nothing was sent.' : 'This application is on file.' }}
        </p>
        <v-btn variant="outlined" block :to="`/applications/${application.id}`">
          Open the application
        </v-btn>
      </template>

      <!-- The resume line follows whether a resume was really written. -->
      <div v-if="application?.hasResume" class="ja__resume">
        <span>Tailored resume ready</span>
        <v-btn
          variant="text"
          size="small"
          prepend-icon="mdi-download"
          :href="`/api/resume/pdf/${application.id}`"
          target="_blank"
        >
          Download PDF
        </v-btn>
      </div>
      <p v-else-if="stage !== 'marked'" class="ja__note">
        {{ resumeLine }}
      </p>

      <v-alert
        v-if="error"
        type="error"
        variant="tonal"
        density="compact"
        closable
        @click:close="emit('dismissError')"
      >
        <div class="text-body-2">{{ error }}</div>
      </v-alert>
    </v-card-text>
  </v-card>
</template>

<style scoped lang="scss">
.ja__row {
  display: flex;
  gap: 8px;
}

.ja__state {
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.5;
}

.ja__note {
  margin: -4px 0 0;
  font-size: 0.8125rem;
  line-height: 1.5;
  color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}

.ja__resume {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 0.875rem;
}
</style>

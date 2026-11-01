<script setup lang="ts">
import type { InferSelectModel } from 'drizzle-orm'
import type { applications, jobs } from '~~/server/db/schema'
import type { ReviewItem } from '#shared/types/pipeline'
import { CAN_APPROVE, CAN_REJECT, clockTime, hostOf, timeAgo } from '~/composables/review/format'

// One application's full record: where it stands, what the pipeline prepared (resume, cover
// letter, the filled employer form with its screenshot), the evidence check behind every line,
// and what happened on submit. Approve and reject live on the review card; this page links there.
definePageMeta({ layout: 'default' })

type Detail = InferSelectModel<typeof applications> & { job: InferSelectModel<typeof jobs> | null; review: ReviewItem | null }

const route = useRoute()
const snackbar = useSnackbar()
const id = computed(() => Number(route.params.id))

const app = ref<Detail | null>(null)
const state = ref<'loading' | 'ready' | 'missing' | 'error'>('loading')
const loadError = ref<string | null>(null)
const busy = ref<null | 'prepare' | 'refill' | 'refresh' | 'notes'>(null)
const savingQuestionId = ref<number | null>(null)
const notes = ref('')

const WORKING = ['preparing', 'approved', 'publishing', 'submitting']
const REPREPARE = ['preparing', 'needs_input', 'proposed', 'needs_manual', 'submit_failed', 'draft', 'ready']
const REFILL = ['needs_input', 'proposed', 'needs_manual', 'submit_failed']
const ANSWERS_MATTER = ['preparing', 'needs_input', 'proposed', 'needs_manual', 'submit_failed']

const review = computed(() => app.value?.review ?? null)
const status = computed(() => app.value?.status ?? '')
const working = computed(() => WORKING.includes(status.value))
const prepareFailed = computed(() => /^prepare_failed/.test(app.value?.formError ?? ''))
const failureText = computed(() => ((app.value?.formError ?? '').split('\n')[0] ?? '').replace(/^prepare_failed attempt=(\d+): /, 'Attempt $1: '))
const reviewable = computed(() => [...CAN_APPROVE, ...CAN_REJECT].includes(status.value as any))
const accountAts = computed(() => ['workday', 'icims', 'taleo', 'successfactors'].includes(app.value?.job?.atsType ?? ''))
const showQuestions = computed(() => ANSWERS_MATTER.includes(status.value) && !!review.value?.openQuestions.length)
const canPrepare = computed(() => REPREPARE.includes(status.value))
const canRefill = computed(() => REFILL.includes(status.value) && !!app.value?.job?.applyUrl && !accountAts.value)
const canRefresh = computed(() => status.value === 'needs_input')

useHead(() => ({ title: app.value?.job ? `${app.value.job.company} · Applications · Job Hunter` : 'Application · Job Hunter' }))

let timer: ReturnType<typeof setTimeout> | null = null
function schedule() {
  if (timer) clearTimeout(timer)
  if (working.value) timer = setTimeout(() => load(true), 3000)
}

async function load(quiet = false) {
  if (!quiet) state.value = 'loading'
  if (!Number.isInteger(id.value) || id.value <= 0) {
    state.value = 'missing'
    return
  }
  try {
    const data = await $fetch<Detail>(`/api/applications/${id.value}`)
    const firstLoad = !app.value
    app.value = data
    if (firstLoad || busy.value !== 'notes') notes.value = data.notes ?? ''
    state.value = 'ready'
  }
  catch (e: any) {
    if (e?.statusCode === 404 || e?.response?.status === 404) state.value = 'missing'
    else if (!quiet) {
      loadError.value = e?.data?.statusMessage || e?.message || 'Could not load this application'
      state.value = 'error'
    }
  }
  finally {
    schedule()
  }
}

onMounted(() => load())
onBeforeUnmount(() => { if (timer) clearTimeout(timer) })

async function run(kind: 'prepare' | 'refill' | 'refresh') {
  if (!app.value || busy.value) return
  busy.value = kind
  try {
    if (kind === 'refresh') {
      const r = await $fetch<{ updated: number; status: string }>(`/api/applications/${app.value.id}/refresh-answers`, { method: 'POST' })
      snackbar.success(r.updated ? `${r.updated} answer${r.updated === 1 ? '' : 's'} updated from your replies` : 'Nothing new to take in')
    }
    else {
      await $fetch(`/api/applications/${app.value.id}/${kind}`, { method: 'POST' })
      snackbar.success(kind === 'prepare' ? 'Preparing again: resume, cover letter, and form' : 'Filling the employer form again')
    }
    await load(true)
  }
  catch (e: any) {
    snackbar.notify(e?.data?.statusMessage || e?.message || 'That did not work', 'error', { timeout: -1 })
  }
  finally {
    busy.value = null
  }
}

async function answer(questionId: number, value: string | null, skip = false) {
  savingQuestionId.value = questionId
  try {
    await $fetch(`/api/questions/${questionId}`, { method: 'PATCH', body: skip ? { status: 'skipped' } : { status: 'answered', answer: value } })
    await load(true)
  }
  catch (e: any) {
    snackbar.notify(e?.data?.statusMessage || e?.message || 'Could not save the answer', 'error', { timeout: -1 })
  }
  finally {
    savingQuestionId.value = null
  }
}

async function saveNotes() {
  if (!app.value) return
  busy.value = 'notes'
  try {
    await $fetch(`/api/applications/${app.value.id}`, { method: 'PATCH', body: { notes: notes.value } })
    snackbar.success('Notes saved')
  }
  catch (e: any) {
    snackbar.notify(e?.data?.statusMessage || e?.message || 'Could not save the notes', 'error', { timeout: -1 })
  }
  finally {
    busy.value = null
  }
}

// ── Section summaries ──
const formSummary = computed(() => {
  const f = review.value?.form
  if (!f?.snapshot) return f?.error ? 'The form could not be used' : accountAts.value ? 'Account required, no form' : 'Not filled yet'
  const filled = f.answers.filter(a => a.filled).length
  const blockers = f.snapshot.blockers.length
  return `${filled} of ${f.snapshot.fields.length} fields filled${blockers ? `, ${blockers} blocker${blockers === 1 ? '' : 's'}` : ''}`
})
const questionsSummary = computed(() => {
  const qs = review.value?.openQuestions ?? []
  const blocking = qs.filter(q => q.blocking).length
  return `${qs.length} open${blocking ? `, ${blocking} blocking` : ''}`
})
const resumeSummary = computed(() => {
  const r = review.value?.resume
  if (!r) return 'Not tailored yet'
  const bullets = r.experience.reduce((n, e) => n + e.bullets.length, 0)
  return `${r.experience.length} roles, ${bullets} bullets`
})
const letterSummary = computed(() => {
  const text = (app.value?.coverLetter ?? '').split('\n\n').slice(1).join(' ').trim()
  return text ? `${text.slice(0, 90)}${text.length > 90 ? '…' : ''}` : 'Not written yet'
})
const evidenceSummary = computed(() => {
  const notes = app.value?.tailoringNotes ?? ''
  const parts = [...notes.matchAll(/^(Resume|Cover letter) evidence check: \d+ lines checked against the knowledge base\. (\d+) supported, (\d+) rewritten, (\d+) dropped\./gm)]
    .map(m => `${m[1]}: ${m[2]} supported, ${m[3]} rewritten, ${m[4]} dropped`)
  return parts.join('. ') || 'No check recorded'
})
const evidenceTone = computed(() => (/\b[1-9]\d* dropped/.test(evidenceSummary.value) ? 'warning' : 'default'))
const submissionSummary = computed(() => {
  const s = review.value?.submission
  if (review.value?.submitError) return 'Submit failed'
  if (!s) return 'Not submitted'
  return s.method === 'automated' ? `Submitted ${clockTime(s.submittedAt)}` : 'Handed back to submit by hand'
})
</script>

<template>
  <div class="ad">
    <div class="ad__top">
      <v-btn to="/applications" variant="text" height="44" prepend-icon="mdi-arrow-left" class="ad__back">Applications</v-btn>
    </div>

    <v-skeleton-loader v-if="state === 'loading'" type="heading, paragraph, image, paragraph" class="ad__skel" />

    <div v-else-if="state === 'missing'" class="ad__state">
      <v-icon icon="mdi-file-question-outline" size="28" />
      <h1 class="ad__state-title">No such application</h1>
      <p class="ad__state-text">It may have been an old link. Every application the pipeline prepared is in the list.</p>
      <v-btn color="primary" height="44" to="/applications">All applications</v-btn>
    </div>

    <div v-else-if="state === 'error'" class="ad__state" role="alert">
      <v-icon icon="mdi-alert-outline" size="28" color="error" />
      <h1 class="ad__state-title">Could not load this application</h1>
      <p class="ad__state-text">{{ loadError }}</p>
      <v-btn variant="outlined" height="44" prepend-icon="mdi-refresh" @click="load()">Try again</v-btn>
    </div>

    <article v-else-if="app" class="ad__card">
      <header class="ad__head">
        <div class="ad__eyebrow">
          <span class="ad__company">{{ app.job?.company || 'Unknown company' }}</span>
          <ApplicationsStatusTag :status="app.status" />
          <span v-if="app.isSandbox" class="ad__sandbox">Sandbox</span>
        </div>
        <h1 class="ad__title">{{ app.job?.title || 'Unknown role' }}</h1>
        <p v-if="app.statusDetail" class="ad__detail" :class="{ 'ad__detail--working': working }" aria-live="polite">
          <v-progress-circular v-if="working" indeterminate size="14" width="2" color="info" />
          {{ app.statusDetail }}
        </p>
        <div class="ad__meta">
          <span v-if="app.job?.location"><v-icon icon="mdi-map-marker-outline" size="15" />{{ app.job.location }}</span>
          <span v-if="review?.form.snapshot?.atsType || app.job?.atsType"><v-icon icon="mdi-form-select" size="15" />{{ review?.form.snapshot?.atsType || app.job?.atsType }} form{{ app.job?.applyUrl ? ` at ${hostOf(app.job.applyUrl)}` : '' }}</span>
          <span v-if="app.job?.matchScore != null" class="tabular"><v-icon icon="mdi-target" size="15" />Match {{ app.job.matchScore }}</span>
          <span><v-icon icon="mdi-clock-outline" size="15" />Updated {{ timeAgo(app.updatedAt) }}</span>
        </div>
        <div class="ad__links">
          <v-btn v-if="reviewable" :to="`/review/${app.id}`" variant="tonal" height="44" prepend-icon="mdi-inbox-arrow-down-outline">Open the review card</v-btn>
          <v-btn v-if="app.job?.url" :href="app.job.url" target="_blank" rel="noopener" variant="outlined" height="44" prepend-icon="mdi-open-in-new">Posting</v-btn>
          <v-btn v-if="app.job" :to="`/jobs/${app.job.id}`" variant="outlined" height="44" prepend-icon="mdi-briefcase-outline">Job details</v-btn>
        </div>
      </header>

      <div v-if="prepareFailed" class="ad__alert" role="alert">
        <v-icon icon="mdi-alert-octagon-outline" size="18" />
        <div>
          <div class="ad__alert-title">Preparation failed</div>
          <div class="ad__alert-text">{{ failureText }}</div>
        </div>
      </div>

      <div v-if="canPrepare || canRefill || canRefresh" class="ad__actions">
        <v-btn
          v-if="canPrepare"
          variant="outlined"
          height="44"
          prepend-icon="mdi-restart"
          :loading="busy === 'prepare'"
          :disabled="!!busy || working"
          @click="run('prepare')"
        >
          Prepare again
        </v-btn>
        <v-btn
          v-if="canRefill"
          variant="outlined"
          height="44"
          prepend-icon="mdi-form-textbox"
          :loading="busy === 'refill'"
          :disabled="!!busy || working"
          @click="run('refill')"
        >
          Fill the form again
        </v-btn>
        <v-btn
          v-if="canRefresh"
          variant="outlined"
          height="44"
          prepend-icon="mdi-sync"
          :loading="busy === 'refresh'"
          :disabled="!!busy"
          @click="run('refresh')"
        >
          Take in my answers
        </v-btn>
        <p class="ad__actions-note">
          Nothing here submits. Filling the form again never attaches files or clicks submit; only Approve on the review card sends an application.
        </p>
      </div>

      <div class="ad__sections">
        <ReviewSection
          v-if="showQuestions && review"
          title="Questions for you"
          icon="mdi-comment-question-outline"
          :summary="questionsSummary"
          tone="warning"
          default-open
        >
          <ReviewQuestions
            :questions="review.openQuestions"
            :saving-id="savingQuestionId"
            @answer="(qid: number, value: string) => answer(qid, value)"
            @skip="(qid: number) => answer(qid, null, true)"
          />
        </ReviewSection>

        <ReviewSection title="Employer form" icon="mdi-form-select" :summary="formSummary" :tone="review?.form.error ? 'error' : 'default'" :default-open="!showQuestions">
          <ReviewFormAnswers
            v-if="review && (review.form.snapshot || review.form.error)"
            :answers="review.form.answers"
            :snapshot="review.form.snapshot"
            :screenshot-url="review.form.screenshotUrl"
            :filled-at="review.form.filledAt"
            :form-error="review.form.error"
            :copy-mode="app.status === 'needs_manual'"
          />
          <p v-else class="ad__empty">
            {{ accountAts ? 'This employer uses an applicant-account system, so there is no form to fill. Apply by hand with the resume and cover letter below.' : working ? 'The form is filled after the resume and cover letter are ready.' : 'The form has not been filled yet.' }}
          </p>
        </ReviewSection>

        <ReviewSection title="Resume" icon="mdi-file-account-outline" :summary="resumeSummary">
          <ReviewResume v-if="review?.resume" :resume="review.resume" :pdf-url="review.resumePdfUrl" />
          <p v-else class="ad__empty">The tailored resume appears here once it is written and checked.</p>
        </ReviewSection>

        <ReviewSection title="Cover letter" icon="mdi-email-outline" :summary="letterSummary">
          <div v-if="app.coverLetter" class="ad__doc">{{ app.coverLetter }}</div>
          <p v-else class="ad__empty">The cover letter appears here once it is written and checked.</p>
        </ReviewSection>

        <ReviewSection title="Evidence check" icon="mdi-shield-check-outline" :summary="evidenceSummary" :tone="evidenceTone">
          <ApplicationsEvidenceCheck :notes="app.tailoringNotes" />
        </ReviewSection>

        <ReviewSection title="Submission" icon="mdi-send-outline" :summary="submissionSummary" :tone="review?.submitError ? 'error' : review?.submission?.method === 'automated' ? 'success' : 'default'">
          <ApplicationsSubmissionPanel :application-id="app.id" :submission="review?.submission ?? null" :submit-error="review?.submitError ?? null" />
        </ReviewSection>

        <ReviewSection title="Your notes" icon="mdi-note-edit-outline" :summary="app.notes ? app.notes.slice(0, 80) : 'None'">
          <v-textarea v-model="notes" label="Notes" placeholder="Interview prep, follow-ups, contacts" rows="4" auto-grow hide-details class="ad__notes" />
          <v-btn variant="outlined" height="44" prepend-icon="mdi-content-save-outline" :loading="busy === 'notes'" :disabled="notes === (app.notes ?? '')" @click="saveNotes">Save notes</v-btn>
        </ReviewSection>
      </div>
    </article>
  </div>
</template>

<style scoped lang="scss">
.ad {
  max-width: 920px;
  margin: 0 auto;
  padding: 8px 0 32px;

  &__top { margin: 0 0 8px -8px; }
  &__skel { border-radius: 12px; }

  &__state {
    display: grid;
    justify-items: start;
    gap: 8px;
    padding: 24px;
    border-radius: 12px;
    background: rgb(var(--v-theme-surface));
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  }

  &__state-title { font-size: 1.125rem; font-weight: 650; margin: 0; }
  &__state-text { margin: 0 0 8px; font-size: 0.875rem; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }

  &__card {
    background: rgb(var(--v-theme-surface));
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    border-radius: 12px;
    padding: 20px 24px 8px;
  }

  &__eyebrow { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; margin-bottom: 4px; }
  &__company { font-weight: 600; font-size: 0.9375rem; color: rgba(var(--v-theme-on-surface), 0.86); }

  &__sandbox {
    font-size: 0.75rem;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 6px;
    color: rgb(var(--v-theme-info));
    border: 1px dashed rgba(var(--v-theme-info), 0.6);
  }

  &__title {
    font-size: 1.375rem;
    font-weight: 700;
    line-height: 1.25;
    letter-spacing: -0.015em;
    margin: 0 0 8px;
    overflow-wrap: anywhere;
  }

  &__detail {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin: 0 0 10px;
    font-size: 0.875rem;
    color: rgba(var(--v-theme-on-surface), 0.86);
    overflow-wrap: anywhere;

    .v-progress-circular { margin-top: 3px; flex-shrink: 0; }
  }

  &__meta {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    font-size: 0.8125rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));

    span { display: inline-flex; align-items: center; gap: 4px; }
  }

  &__links { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }

  &__alert {
    display: flex;
    gap: 10px;
    margin-top: 16px;
    padding: 12px 14px;
    border-radius: 8px;
    color: rgb(var(--v-theme-error));
    background: rgba(var(--v-theme-error), 0.08);
    border: 1px solid rgba(var(--v-theme-error), 0.3);
  }

  &__alert-title { font-weight: 600; font-size: 0.875rem; }
  &__alert-text { font-size: 0.8125rem; color: rgba(var(--v-theme-on-surface), 0.86); overflow-wrap: anywhere; }

  &__actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-top: 16px;
    padding: 14px 16px;
    border-radius: 8px;
    background: rgb(var(--v-theme-background));
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  }

  &__actions-note {
    flex-basis: 100%;
    margin: 4px 0 0;
    font-size: 0.8125rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__sections { margin-top: 12px; }

  &__doc {
    white-space: pre-line;
    font-size: 0.875rem;
    line-height: 1.65;
    padding: 16px 18px;
    border-radius: 8px;
    background: rgb(var(--v-theme-sunken));
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    max-height: 520px;
    overflow-y: auto;
  }

  &__empty { margin: 0; font-size: 0.875rem; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
  &__notes { margin-bottom: 12px; }
}

@media (max-width: 599px) {
  .ad__card { padding: 16px 16px 4px; border-radius: 10px; }
  .ad__links .v-btn, .ad__actions .v-btn { flex: 1 1 100%; }
}
</style>

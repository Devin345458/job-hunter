<script setup lang="ts">
import type { ReviewItem } from '#shared/types/pipeline'
import { clockTime, hostOf } from '~/composables/review/format'
import { plainConfirmation, plainError } from '#shared/utils/plain-text'

// What happened after approve: a step track while the server works, then the outcome. A card
// whose preparation failed never reached approve, so it says that instead and offers a retry.
const props = defineProps<{ item: ReviewItem; preparing?: boolean }>()
const emit = defineEmits<{ prepare: [] }>()

/** Preparation threw before anything could be submitted (form_error starts with prepare_failed). */
const prepareFailed = computed(() => /^prepare_failed/.test(props.item.form.error ?? ''))
const prepareAttempt = computed(() => Number(/^prepare_failed attempt=(\d+)/.exec(props.item.form.error ?? '')?.[1] ?? 0))
const prepareReason = computed(() => plainError(props.item.form.error))
const detailText = computed(() => plainError(props.item.statusDetail))
/** "writing the cover letter": the status detail the preparation keeps current, lower case after "Preparing:". */
const preparingStep = computed(() => {
  const t = (detailText.value || 'Waiting in the queue to prepare').replace(/\.$/, '')
  return /^[A-Z][a-z]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t
})
const submitErrorText = computed(() => {
  const t = plainError(props.item.submitError)
  return t && t !== detailText.value ? t : ''
})

const hasDemoStep = computed(() => {
  const s = props.item.demo?.status
  return s === 'built' || s === 'publishing' || s === 'published' || props.item.status === 'publishing'
})

type StepState = 'done' | 'active' | 'todo' | 'failed'
interface Step { key: string; label: string; state: StepState }

const steps = computed<Step[]>(() => {
  const status = props.item.status
  const order = ['approved', ...(hasDemoStep.value ? ['publishing'] : []), 'submitting', 'submitted']
  const labels: Record<string, string> = { approved: 'Approved', publishing: 'Publish demo', submitting: 'Submit form', submitted: 'Submitted' }
  let current = order.indexOf(status)
  let failedAt = -1
  if (status === 'submit_failed') {
    failedAt = props.item.statusDetail?.toLowerCase().includes('demo publish') ? order.indexOf('publishing') : order.indexOf('submitting')
    current = failedAt
  }
  if (status === 'needs_manual') current = order.indexOf('submitting')
  return order.map((key, i) => ({
    key,
    label: key === 'submitting' && status === 'needs_manual' ? 'Submit by hand' : labels[key]!,
    state: i === failedAt ? 'failed' : status === 'submitted' || i < current ? 'done' : i === current ? 'active' : 'todo',
  }))
})

const submissionShot = computed(() => props.item.submission?.screenshotPath ? `/api/files/screenshot/${props.item.applicationId}?kind=submission` : null)
</script>

<template>
  <div class="prog">
    <!-- Preparation failed: nothing was written, so there is nothing to submit by hand yet -->
    <div v-if="item.status === 'needs_manual' && prepareFailed" class="prog__panel prog__panel--error prog__panel--first" role="alert">
      <div class="prog__panel-title">
        <v-icon icon="mdi-alert-octagon-outline" size="18" />
        Preparation failed
      </div>
      <p class="prog__panel-text">{{ prepareReason || 'The preparation stopped with an error.' }}</p>
      <p class="prog__panel-hint">
        <template v-if="prepareAttempt < 3">
          Nothing was written for this application yet. The next scheduled run continues it (attempt {{ prepareAttempt }} of 3 so far), or prepare it again now.
        </template>
        <template v-else>
          Three attempts failed, so the scheduled runs stop retrying it. Prepare it again once the cause is fixed.
        </template>
      </p>
      <div class="prog__links">
        <v-btn color="primary" height="44" prepend-icon="mdi-restart" :loading="preparing" @click="emit('prepare')">
          Prepare again
        </v-btn>
        <v-btn :to="`/applications/${item.applicationId}`" variant="tonal" height="44" prepend-icon="mdi-file-document-outline">
          Application details
        </v-btn>
      </div>
    </div>

    <!-- Preparing after Apply, or Prepare again: the step it is on now -->
    <div v-else-if="item.status === 'preparing'" class="prog__panel prog__panel--info prog__panel--first" role="status">
      <div class="prog__panel-title">
        <v-progress-circular indeterminate size="16" width="2" />
        Preparing: {{ preparingStep }}
      </div>
      <p class="prog__panel-hint">This card moves to Ready to send when the resume, cover letter, and form answers are written and the form is filled. Nothing is sent until you approve it.</p>
    </div>

    <ol v-else class="prog__steps" aria-label="Progress after approve">
      <li
        v-for="s in steps"
        :key="s.key"
        class="prog__step"
        :class="`prog__step--${s.state}`"
        :aria-current="s.state === 'active' ? 'step' : undefined"
      >
        <span class="prog__marker">
          <v-icon v-if="s.state === 'done'" icon="mdi-check" size="14" />
          <v-icon v-else-if="s.state === 'failed'" icon="mdi-close" size="14" />
          <v-progress-circular v-else-if="s.state === 'active' && item.status !== 'needs_manual'" indeterminate size="12" width="2" />
          <v-icon v-else-if="s.state === 'active'" icon="mdi-hand-pointing-right" size="14" />
        </span>
        <span class="prog__label">{{ s.label }}</span>
      </li>
    </ol>

    <p v-if="detailText && !['submitted', 'submit_failed', 'needs_manual', 'preparing'].includes(item.status)" class="prog__detail" role="status">
      {{ detailText }}
    </p>

    <!-- Submitted -->
    <div v-if="item.status === 'submitted'" class="prog__panel prog__panel--success">
      <div class="prog__panel-title">
        <v-icon icon="mdi-check-circle-outline" size="18" />
        Submitted {{ clockTime(item.submission?.submittedAt) }}
        <span v-if="item.submission?.sandbox || item.isSandbox" class="prog__sandbox">sandbox</span>
      </div>
      <p v-if="item.submission?.confirmationText" class="prog__confirm">"{{ plainConfirmation(item.submission.confirmationText) }}"</p>
      <div class="prog__links">
        <v-btn v-if="item.submission?.finalUrl" :href="item.submission.finalUrl" target="_blank" rel="noopener" variant="tonal" height="44" prepend-icon="mdi-open-in-new">
          Confirmation page
        </v-btn>
        <v-btn v-if="submissionShot" :href="submissionShot" target="_blank" rel="noopener" variant="tonal" height="44" prepend-icon="mdi-image-outline">
          Confirmation screenshot
        </v-btn>
      </div>
    </div>

    <!-- Failed -->
    <div v-else-if="item.status === 'submit_failed'" class="prog__panel prog__panel--error" role="alert">
      <div class="prog__panel-title">
        <v-icon icon="mdi-alert-octagon-outline" size="18" />
        Submit failed
      </div>
      <p class="prog__panel-text">{{ detailText || 'The submit step stopped with an error.' }}</p>
      <p v-if="submitErrorText" class="prog__panel-text">{{ submitErrorText }}</p>
      <p class="prog__panel-hint">
        Retry runs the same submit again. If the error came after the form was sent, check {{ hostOf(item.job.applyUrl) || 'the employer site' }} first so you do not apply twice.
      </p>
    </div>

    <!-- Manual -->
    <div v-else-if="item.status === 'needs_manual' && !prepareFailed" class="prog__panel prog__panel--warning">
      <div class="prog__panel-title">
        <v-icon icon="mdi-hand-pointing-right" size="18" />
        Submit this one yourself
      </div>
      <p class="prog__panel-text">{{ detailText || 'The pipeline cannot submit this form.' }}</p>
      <p class="prog__panel-hint">
        Open the form, paste the answers below with the copy buttons, and attach the resume PDF.
      </p>
      <div class="prog__links">
        <v-btn
          v-if="item.job.applyUrl || item.job.url"
          :href="item.job.applyUrl || item.job.url || undefined"
          target="_blank"
          rel="noopener"
          color="primary"
          height="44"
          prepend-icon="mdi-open-in-new"
        >
          Open application form
        </v-btn>
        <v-btn v-if="item.resumePdfUrl" :href="item.resumePdfUrl" target="_blank" rel="noopener" variant="tonal" height="44" prepend-icon="mdi-file-pdf-box">
          Resume PDF
        </v-btn>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.prog {
  &__steps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 6px 4px;
  }

  &__step {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.8125rem;
    color: rgba(var(--v-theme-on-surface), var(--v-disabled-opacity));

    &:not(:last-child)::after {
      content: '';
      width: 18px;
      height: 1px;
      margin-left: 2px;
      background: rgba(var(--v-border-color), 0.3);
    }

    &--done { color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
    &--active { color: rgb(var(--v-theme-on-surface)); font-weight: 600; }
    &--failed { color: rgb(var(--v-theme-error)); font-weight: 600; }
  }

  &__marker {
    width: 20px;
    height: 20px;
    border-radius: 5px;
    display: grid;
    place-items: center;
    flex-shrink: 0;
    border: 1px solid rgba(var(--v-border-color), 0.25);
  }

  &__step--done &__marker {
    border-color: transparent;
    background: rgba(var(--v-theme-success), 0.16);
    color: rgb(var(--v-theme-success));
  }

  &__step--active &__marker {
    border-color: rgba(var(--v-theme-primary), 0.6);
    color: rgb(var(--v-theme-primary));
  }

  &__step--failed &__marker {
    border-color: transparent;
    background: rgba(var(--v-theme-error), 0.16);
  }

  &__detail {
    margin: 10px 0 0;
    font-size: 0.875rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__panel {
    margin-top: 12px;

    &--first {
      margin-top: 0;
    }

    padding: 14px 16px;
    border-radius: 8px;
    border: 1px solid;

    &--success { border-color: rgba(var(--v-theme-success), 0.35); background: rgba(var(--v-theme-success), 0.06); }
    &--error { border-color: rgba(var(--v-theme-error), 0.4); background: rgba(var(--v-theme-error), 0.06); }
    &--warning { border-color: rgba(var(--v-theme-warning), 0.4); background: rgba(var(--v-theme-warning), 0.06); }
    &--info { border-color: rgba(var(--v-theme-info), 0.4); background: rgba(var(--v-theme-info), 0.06); }
  }

  &__panel-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 650;
    font-size: 0.9375rem;
  }

  &__panel--success &__panel-title { color: rgb(var(--v-theme-success)); }
  &__panel--error &__panel-title { color: rgb(var(--v-theme-error)); }
  &__panel--warning &__panel-title { color: rgb(var(--v-theme-warning)); }
  &__panel--info &__panel-title { color: rgb(var(--v-theme-info)); }

  &__sandbox {
    font-size: 0.75rem;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 4px;
    color: rgb(var(--v-theme-on-surface));
    background: rgba(var(--v-theme-on-surface), 0.1);
  }

  &__panel-text {
    margin: 6px 0 0;
    font-size: 0.875rem;
    overflow-wrap: anywhere;
  }

  &__panel-hint {
    margin: 6px 0 0;
    font-size: 0.8125rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__confirm {
    margin: 6px 0 0;
    font-size: 0.875rem;
  }

  &__links {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 12px;
  }
}
</style>

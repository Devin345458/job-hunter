<script setup lang="ts">
import type { SubmissionResult } from '#shared/types/pipeline'
import { clockTime } from '~/composables/review/format'
import { plainError } from '#shared/utils/plain-text'

// What happened on submit: sent automatically (with the confirmation the employer showed and a
// screenshot of it), handed back for a manual submit (with the reason), or failed (with the error).
const props = defineProps<{
  applicationId: number
  submission: SubmissionResult | null
  submitError: string | null
}>()

const shotOpen = ref(false)
const shotUrl = computed(() => `/api/files/screenshot/${props.applicationId}?kind=submission`)
</script>

<template>
  <div class="sp">
    <div v-if="submitError" class="sp__error" role="alert">
      <v-icon icon="mdi-alert-octagon-outline" size="16" />
      <span class="sp__error-text">{{ plainError(submitError) }}</span>
    </div>

    <template v-if="submission">
      <dl class="sp__facts">
        <dt>How</dt>
        <dd>{{ submission.method === 'automated' ? (submission.sandbox ? 'Submitted automatically to the sandbox form' : 'Submitted automatically') : 'Handed back to you to submit by hand' }}</dd>
        <dt>When</dt>
        <dd>{{ clockTime(submission.submittedAt) }}</dd>
        <template v-if="submission.manualReason">
          <dt>Why by hand</dt>
          <dd>{{ submission.manualReason }}</dd>
        </template>
        <template v-if="submission.confirmationText">
          <dt>Employer said</dt>
          <dd class="sp__quote">{{ submission.confirmationText }}</dd>
        </template>
        <template v-if="submission.finalUrl">
          <dt>Final page</dt>
          <dd class="sp__url">{{ submission.finalUrl }}</dd>
        </template>
      </dl>
      <v-btn v-if="submission.screenshotPath" variant="outlined" height="44" prepend-icon="mdi-image-outline" class="sp__btn" @click="shotOpen = !shotOpen">
        {{ shotOpen ? 'Hide' : 'Show' }} the confirmation screenshot
      </v-btn>
      <img v-if="shotOpen" :src="shotUrl" alt="Screenshot of the page after submitting" class="sp__shot" loading="lazy">
    </template>
    <p v-else-if="!submitError" class="sp__empty">Nothing has been submitted. Only Approve sends an application.</p>
  </div>
</template>

<style scoped lang="scss">
.sp {
  display: grid;
  gap: 12px;

  &__error {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    font-size: 0.875rem;
    padding: 10px 12px;
    border-radius: 8px;
    color: rgb(var(--v-theme-error));
    background: rgba(var(--v-theme-error), 0.08);
    border: 1px solid rgba(var(--v-theme-error), 0.3);
    overflow-wrap: anywhere;
  }

  &__error-text {
    min-width: 0;
  }

  &__facts {
    display: grid;
    grid-template-columns: minmax(96px, auto) 1fr;
    gap: 8px 16px;
    margin: 0;
    font-size: 0.875rem;

    dt { color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
    dd { margin: 0; overflow-wrap: anywhere; }
  }

  &__quote { border-left: 2px solid rgb(var(--v-theme-primary)); padding-left: 10px; font-size: 0.8125rem; }
  &__url { font-size: 0.8125rem; }
  &__btn { justify-self: start; }

  &__shot {
    width: 100%;
    border-radius: 8px;
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  }

  &__empty { margin: 0; font-size: 0.875rem; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
}

@media (max-width: 599px) {
  .sp__facts { grid-template-columns: 1fr; gap: 2px; }
  .sp__facts dd { margin-bottom: 8px; }
}
</style>

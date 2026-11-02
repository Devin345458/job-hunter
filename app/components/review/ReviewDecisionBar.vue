<script setup lang="ts">
import type { ReviewItem } from '#shared/types/pipeline'
import { CAN_APPROVE, CAN_REJECT, hostOf, plural } from '~/composables/review/format'

// The decision, pinned to the bottom of the card. Approve is one tap on a plain primary
// button (never a swipe); the line beside it says exactly what that tap sends and to whom.
const props = defineProps<{
  item: ReviewItem
  approving: boolean
  refreshing: boolean
}>()

const emit = defineEmits<{
  approve: []
  reject: []
}>()

const blocking = computed(() => props.item.openQuestions.filter(q => q.blocking).length)
const demoBlocked = computed(() => props.item.approveEffect?.demoBlocked ?? null)
const canApprove = computed(() => CAN_APPROVE.includes(props.item.status) && blocking.value === 0 && !demoBlocked.value)
const canReject = computed(() => CAN_REJECT.includes(props.item.status))
const isRetry = computed(() => props.item.status === 'submit_failed')
const isManual = computed(() => props.item.status === 'needs_manual')
const prepareFailed = computed(() => isManual.value && /^prepare_failed/.test(props.item.form.error ?? ''))
// An approved application that came back as submit by hand (captcha, or real submits switched
// off) can try the automated submit again; the server reuses the original approve decision.
const canRetryManual = computed(() => isManual.value && !prepareFailed.value && props.item.submission?.method === 'manual')
const demoWillPublish = computed(() => props.item.demo?.status === 'built')

const approveLabel = computed(() => (isRetry.value ? 'Retry submit' : props.item.approveEffect?.submit === 'manual' && !props.item.isSandbox ? 'Approve' : 'Approve and submit'))

/**
 * Every reason approve is off, one line each, said in the bar rather than a tooltip so it reads
 * on a phone. Open questions and a demo that cannot publish are separate problems; showing only
 * the first left the second hidden until the first was fixed.
 */
const blockedReasons = computed<string[]>(() => {
  const status = props.item.status
  const out: string[] = []
  if (blocking.value > 0) out.push(`Answer ${plural(blocking.value, 'question')} above to unlock approve.`)
  else if (status === 'needs_input') {
    out.push(props.refreshing ? 'Updating the form answers with what you said.' : 'Answers saved. Approve unlocks when the pipeline marks this ready.')
  }
  if (demoBlocked.value && (CAN_APPROVE.includes(status) || status === 'needs_input')) {
    out.push(`${demoBlocked.value.replace(/\.$/, '')}. Set it, or discard the demo, to approve.`)
  }
  return out
})

/**
 * The phone's one-line version of the consequence; the full sentence is one tap away under the
 * info button, so the decision bar leaves the card readable on a 390px screen.
 */
const shortConsequence = computed(() => {
  const effect = props.item.approveEffect
  const company = props.item.job.company || hostOf(props.item.job.applyUrl)
  const demo = demoWillPublish.value && !isRetry.value
  if (props.item.isSandbox || effect?.submit === 'sandbox') return demo ? 'Publishes the demo, then sends it to the sandbox form.' : 'Sends it to the sandbox test form.'
  if (effect?.submit === 'manual') return demo ? `Publishes the demo, then you submit on ${company}'s site.` : `Marks it for you to submit on ${company}'s site.`
  return demo ? `Publishes the demo, then sends it to ${company}.` : `Sends the application to ${company}.`
})
const detailsOpen = ref(false)
watch(() => props.item.applicationId, () => { detailsOpen.value = false })
/** Only the plain consequence line has a short form; blockers and by-hand notes always show in full. */
const hasShortForm = computed(() => !blockedReasons.value.length && !prepareFailed.value && !isManual.value)

const consequence = computed(() => {
  const effect = props.item.approveEffect
  const company = props.item.job.company || hostOf(props.item.job.applyUrl)
  const demo = demoWillPublish.value && !isRetry.value ? 'Publishes the demo repo, then ' : ''
  if (props.item.isSandbox || effect?.submit === 'sandbox') return `${demo ? demo : ''}${demo ? 'sends' : 'Sends'} the application to the sandbox test form under your name.`
  if (effect?.submit === 'manual') {
    const why = effect.manualReason ? ` (${effect.manualReason})` : ''
    return `${demo}${demo ? 'marks' : 'Marks'} it approved for you to submit on ${company}'s site yourself${why}. The resume, cover letter, and answers stay here to copy.`
  }
  return `${demo}${demo ? 'sends' : 'Sends'} the application to ${company} under your name.`
})
</script>

<template>
  <div v-if="canApprove || canReject || isManual || item.status === 'needs_input'" class="bar">
    <div v-if="blockedReasons.length" class="bar__line bar__reasons" role="status">
      <p v-for="r in blockedReasons" :key="r" class="bar__reason">
        <v-icon icon="mdi-lock-outline" size="15" class="bar__reason-icon" />
        <span>{{ r }}</span>
      </p>
    </div>
    <p v-else class="bar__line" :class="{ 'bar__line--long': hasShortForm, 'bar__line--open': detailsOpen }" role="status" :id="`bar-detail-${item.applicationId}`">
      <template v-if="prepareFailed">Nothing to submit until preparation succeeds. Reject it if you no longer want this job.</template>
      <template v-else-if="isManual">
        <template v-if="item.submission?.manualReason">{{ item.submission.manualReason }}. </template>Submit it on the employer's site, or reject if you changed your mind.
      </template>
      <template v-else>{{ consequence }}</template>
    </p>
    <p v-if="hasShortForm" class="bar__line bar__line--short" :class="{ 'bar__line--open': detailsOpen }">{{ shortConsequence }}</p>
    <div class="bar__buttons">
      <v-btn
        v-if="hasShortForm"
        variant="text"
        width="44"
        height="48"
        class="bar__info"
        :icon="detailsOpen ? 'mdi-information' : 'mdi-information-outline'"
        :aria-expanded="detailsOpen"
        :aria-controls="`bar-detail-${item.applicationId}`"
        aria-label="What approve does, in full"
        @click="detailsOpen = !detailsOpen"
      />
      <v-btn
        v-if="canReject"
        variant="outlined"
        height="48"
        class="bar__reject"
        prepend-icon="mdi-close"
        :disabled="approving"
        @click="emit('reject')"
      >
        {{ isManual ? 'Not applying' : 'Reject' }}
      </v-btn>
      <v-btn
        v-if="canRetryManual"
        variant="tonal"
        height="48"
        class="bar__approve"
        prepend-icon="mdi-refresh"
        :disabled="blocking > 0"
        :loading="approving"
        @click="emit('approve')"
      >
        Try automated submit again
      </v-btn>
      <v-btn
        v-if="!isManual"
        :color="canApprove ? 'primary' : undefined"
        :variant="canApprove ? 'flat' : 'tonal'"
        height="48"
        class="bar__approve"
        :prepend-icon="isRetry ? 'mdi-refresh' : 'mdi-send-check-outline'"
        :disabled="!canApprove"
        :loading="approving"
        @click="emit('approve')"
      >
        {{ approveLabel }}
      </v-btn>
    </div>
  </div>
</template>

<style scoped lang="scss">
.bar {
  display: flex;
  align-items: center;
  gap: 12px 20px;
  padding: 12px 20px;
  border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgb(var(--v-theme-surface));

  &__line {
    flex: 1;
    min-width: 0;
    margin: 0;
    font-size: 0.8125rem;
    line-height: 1.45;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));

  }

  &__reasons {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  &__reason {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    margin: 0;
    color: rgb(var(--v-theme-warning));
  }

  &__reason-icon {
    flex-shrink: 0;
    margin-top: 1px;
  }

  &__buttons {
    display: flex;
    gap: 10px;
    flex-shrink: 0;
  }

  &__approve {
    min-width: 188px;
  }

  &__reject {
    min-width: 112px;
  }

  // Desktop shows the full sentence; the short line and its info button are for the phone.
  &__line--short,
  &__info {
    display: none !important;
  }
}

@media (max-width: 599.98px) {
  .bar {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
    padding: 10px 16px 12px;

    &__line {
      font-size: 0.75rem;
    }

    &__buttons > * {
      flex: 1;
    }

    &__reject {
      flex: 0 0 auto !important;
      min-width: 112px;
    }

    &__approve {
      min-width: 0;
    }

    // One line on the phone; the info button swaps in the full sentence.
    &__line--long:not(.bar__line--open) {
      display: none;
    }

    &__line--short {
      display: block !important;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;

      &.bar__line--open {
        display: none !important;
      }
    }

    &__info {
      display: inline-flex !important;
      flex: 0 0 44px !important;
      min-width: 44px;
    }
  }
}
</style>

<script setup lang="ts">
import type { ReviewItem } from '#shared/types/pipeline'
import { CAN_APPROVE, CAN_REJECT, hostOf } from '~/composables/review/format'

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
const canApprove = computed(() => CAN_APPROVE.includes(props.item.status) && blocking.value === 0)
const canReject = computed(() => CAN_REJECT.includes(props.item.status))
const isRetry = computed(() => props.item.status === 'submit_failed')
const isManual = computed(() => props.item.status === 'needs_manual')
const demoWillPublish = computed(() => props.item.demo?.status === 'built')

const approveLabel = computed(() => (isRetry.value ? 'Retry submit' : 'Approve and submit'))

/** Why approve is off, said in the bar rather than a tooltip so it reads on a phone. */
const blockedReason = computed(() => {
  if (props.item.status === 'needs_input') {
    if (blocking.value > 0) return `Answer ${blocking.value} question${blocking.value === 1 ? '' : 's'} above to unlock approve.`
    if (props.refreshing) return 'Updating the form answers with what you said.'
    return 'Answers saved. Approve unlocks when the pipeline marks this ready.'
  }
  if (blocking.value > 0) return `Answer ${blocking.value} question${blocking.value === 1 ? '' : 's'} above to unlock approve.`
  return null
})

const consequence = computed(() => {
  const target = props.item.isSandbox ? 'the sandbox test form' : (props.item.job.company || hostOf(props.item.job.applyUrl))
  const parts = []
  if (demoWillPublish.value && !isRetry.value) parts.push('Publishes the demo repo, then sends')
  else parts.push('Sends')
  parts.push(`the application to ${target} under your name.`)
  return parts.join(' ')
})
</script>

<template>
  <div v-if="canApprove || canReject || isManual || item.status === 'needs_input'" class="bar">
    <p class="bar__line" :class="{ 'bar__line--blocked': !!blockedReason }" role="status">
      <template v-if="blockedReason">
        <v-icon icon="mdi-lock-outline" size="15" />
        {{ blockedReason }}
      </template>
      <template v-else-if="isManual">
        Submit it on the employer's site, or reject if you changed your mind.
      </template>
      <template v-else>{{ consequence }}</template>
    </p>
    <div class="bar__buttons">
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

    &--blocked {
      color: rgb(var(--v-theme-warning));
      display: flex;
      align-items: center;
      gap: 6px;
    }
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
  }
}
</style>

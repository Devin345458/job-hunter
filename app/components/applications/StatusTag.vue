<script setup lang="ts">
import type { ApplicationStatus } from '#shared/types/pipeline'
import { REVIEW_STATUS, type StatusMeta } from '~/composables/review/format'
import { APP_STATE_LABEL, PREPARE_FAILED_LABEL } from '#shared/utils/app-state'

// Status tag for every ApplicationStatus: the review vocabulary for pipeline states, plus the
// states only this page shows (preparing, and the original manual-tracking states).
const props = defineProps<{
  status: ApplicationStatus | string
  /** The application's form_error: a needs_manual row whose preparation failed is tagged as that. */
  formError?: string | null
}>()

const L = APP_STATE_LABEL
const EXTRA: Record<string, Omit<StatusMeta, 'group'>> = {
  preparing: { label: L.preparing!, color: 'info', icon: 'mdi-progress-clock' },
  draft: { label: L.draft!, color: 'secondary', icon: 'mdi-file-outline' },
  ready: { label: L.ready!, color: 'secondary', icon: 'mdi-file-check-outline' },
  response_received: { label: L.response_received!, color: 'success', icon: 'mdi-email-open-outline' },
  interviewing: { label: L.interviewing!, color: 'success', icon: 'mdi-account-voice' },
  rejected: { label: L.rejected!, color: 'error', icon: 'mdi-close-circle-outline' },
  offer: { label: L.offer!, color: 'success', icon: 'mdi-trophy-outline' },
  no_response: { label: L.no_response!, color: 'secondary', icon: 'mdi-email-off-outline' },
}

const meta = computed(() => {
  if (props.status === 'needs_manual' && /^prepare_failed/.test(props.formError ?? '')) return { label: PREPARE_FAILED_LABEL, color: 'error', icon: 'mdi-alert-octagon-outline' }
  return REVIEW_STATUS[props.status as ApplicationStatus] ?? EXTRA[props.status] ?? { label: String(props.status).replace(/_/g, ' '), color: 'secondary', icon: 'mdi-circle-small' }
})
</script>

<template>
  <span class="ast" :class="`ast--${meta.color}`">
    <v-icon :icon="meta.icon" size="14" aria-hidden="true" />{{ meta.label }}
  </span>
</template>

<style scoped lang="scss">
.ast {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.75rem;
  font-weight: 500;
  line-height: 1.4;
  padding: 1px 8px;
  border-radius: 6px;
  white-space: nowrap;

  @each $c in primary, warning, error, success, secondary, info {
    &--#{$c} {
      color: rgb(var(--v-theme-#{$c}));
      background: rgba(var(--v-theme-#{$c}), 0.12);
    }
  }
}
</style>

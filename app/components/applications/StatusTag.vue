<script setup lang="ts">
import type { ApplicationStatus } from '#shared/types/pipeline'
import { REVIEW_STATUS, type StatusMeta } from '~/composables/review/format'

// Status tag for every ApplicationStatus: the review vocabulary for pipeline states, plus the
// states only this page shows (preparing, and the original manual-tracking states).
const props = defineProps<{ status: ApplicationStatus | string }>()

const EXTRA: Record<string, Omit<StatusMeta, 'group'>> = {
  preparing: { label: 'Preparing', color: 'info', icon: 'mdi-progress-clock' },
  draft: { label: 'Draft', color: 'secondary', icon: 'mdi-file-outline' },
  ready: { label: 'Ready', color: 'secondary', icon: 'mdi-file-check-outline' },
  response_received: { label: 'Employer replied', color: 'success', icon: 'mdi-email-open-outline' },
  interviewing: { label: 'Interviewing', color: 'success', icon: 'mdi-account-voice' },
  rejected: { label: 'Employer said no', color: 'error', icon: 'mdi-close-circle-outline' },
  offer: { label: 'Offer', color: 'success', icon: 'mdi-trophy-outline' },
}

const meta = computed(() => REVIEW_STATUS[props.status as ApplicationStatus] ?? EXTRA[props.status] ?? { label: String(props.status).replace(/_/g, ' '), color: 'secondary', icon: 'mdi-circle-small' })
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
  font-weight: 600;
  line-height: 1.4;
  padding: 2px 8px;
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

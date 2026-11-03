<script lang="ts">
import { GROUP_LABEL, statusesIn } from '~/composables/review/format'

// Filter strip for the applications list: one chip per stage with its count. The stages follow
// the review queue's groups with one difference: an application waiting on Devin's answers
// (needs_input, tagged "Needs your answer") counts under "Needs you" here, not "Ready to send",
// so the tab agrees with the tag on its cards. The review queue still lists it among the cards
// ready to send.
export type StageKey = 'all' | 'decide' | 'send' | 'needs_you' | 'working' | 'sent' | 'closed'

const WAITING_ON_YOU: string[] = ['needs_input']

export const STAGES: Array<{ key: StageKey; label: string; statuses: string[] }> = [
  { key: 'all', label: 'All', statuses: [] },
  { key: 'decide', label: GROUP_LABEL.decide, statuses: statusesIn('decide') },
  { key: 'send', label: GROUP_LABEL.send, statuses: statusesIn('send').filter(s => !WAITING_ON_YOU.includes(s)) },
  { key: 'needs_you', label: GROUP_LABEL.attention, statuses: [...WAITING_ON_YOU, ...statusesIn('attention')] },
  { key: 'working', label: 'In progress', statuses: [...statusesIn('preparing'), ...statusesIn('sending')] },
  { key: 'sent', label: GROUP_LABEL.sent, statuses: [...statusesIn('sent'), 'response_received', 'interviewing', 'offer'] },
  // Employer outcomes that end it (rejected, no response) close it; the rest stay under Submitted.
  { key: 'closed', label: GROUP_LABEL.closed, statuses: ['declined', 'rejected', 'no_response', 'draft', 'ready'] },
]
</script>

<script setup lang="ts">
// modelValue is null while an outcome filter on the Applications page is on instead of a stage.
const props = defineProps<{ counts: Record<StageKey, number>; modelValue: StageKey | null }>()
const emit = defineEmits<{ 'update:modelValue': [StageKey] }>()
</script>

<template>
  <div class="asp" role="tablist" aria-label="Filter applications by stage">
    <button
      v-for="s in STAGES"
      :key="s.key"
      type="button"
      role="tab"
      class="asp__chip"
      :class="{ 'asp__chip--on': props.modelValue === s.key, 'asp__chip--alert': s.key === 'needs_you' && props.counts.needs_you > 0 }"
      :aria-selected="props.modelValue === s.key"
      @click="emit('update:modelValue', s.key)"
    >
      {{ s.label }}
      <span class="asp__count tabular">{{ props.counts[s.key] ?? 0 }}</span>
    </button>
  </div>
</template>

<style scoped lang="scss">
.asp {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;

  &__chip {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    padding: 0 14px;
    border-radius: 8px;
    font-size: 0.875rem;
    font-weight: 600;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    background: rgb(var(--v-theme-surface));
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    transition: border-color 150ms cubic-bezier(0.23, 1, 0.32, 1), color 150ms cubic-bezier(0.23, 1, 0.32, 1);

    &:hover { color: rgb(var(--v-theme-on-surface)); }
    &:focus-visible { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: 2px; }

    &--on {
      color: rgb(var(--v-theme-on-surface));
      border-color: rgba(var(--v-theme-primary), 0.6);
    }
  }

  &__count {
    font-size: 0.75rem;
    min-width: 20px;
    padding: 1px 6px;
    border-radius: 6px;
    text-align: center;
    background: rgb(var(--v-theme-background));
  }

  &__chip--alert &__count {
    color: rgb(var(--v-theme-warning));
    background: rgba(var(--v-theme-warning), 0.12);
  }
}

@media (prefers-reduced-motion: reduce) {
  .asp__chip { transition: none; }
}
</style>

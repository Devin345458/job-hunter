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

/** All, every stage with a count, and the open one even when it emptied. */
const visible = computed(() => STAGES.filter(s => s.key === 'all' || (props.counts[s.key] ?? 0) > 0 || props.modelValue === s.key))
</script>

<template>
  <div class="asp" role="tablist" aria-label="Filter applications by stage">
    <button
      v-for="s in visible"
      :key="s.key"
      type="button"
      role="tab"
      class="asp__tab"
      :class="{ 'asp__tab--on': props.modelValue === s.key }"
      :aria-selected="props.modelValue === s.key"
      @click="emit('update:modelValue', s.key)"
    >
      {{ s.label }}
      <span class="asp__count" :class="{ 'asp__count--alert': s.key === 'needs_you' }">{{ (props.counts[s.key] ?? 0).toLocaleString('en-US') }}</span>
    </button>
  </div>
</template>

<style scoped lang="scss">
// Underline tabs on one full-width rule; the open tab is ink with a 2px ink indicator. On a phone
// the row scrolls sideways inside itself, never the page.
.asp {
  display: flex;
  gap: 4px;
  overflow-x: auto;
  scrollbar-width: none;
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));

  &::-webkit-scrollbar { display: none; }

  // A narrow phone wraps the tabs to a second line rather than hiding one past the edge.
  @media (max-width: 599.98px) {
    flex-wrap: wrap;
    overflow-x: visible;
  }

  &__tab {
    position: relative;
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 40px;
    padding: 0 10px;
    font-size: 0.875rem;
    font-weight: 500;
    white-space: nowrap;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    transition: color 150ms cubic-bezier(0.23, 1, 0.32, 1);

    &:hover { color: rgb(var(--v-theme-on-surface)); }
    &:focus-visible { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: -2px; border-radius: 6px; }

    &--on {
      color: rgb(var(--v-theme-on-surface));

      &::after {
        content: '';
        position: absolute;
        left: 6px;
        right: 6px;
        bottom: -1px;
        height: 2px;
        border-radius: 1px;
        background: rgb(var(--v-theme-on-surface));
      }
    }

    @media (max-width: 959.98px) {
      min-height: 44px;
    }
  }

  &__count {
    font-weight: 400;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));

    // Needs you: the applications held up on Devin, in amber.
    &--alert { color: rgb(var(--v-theme-warning)); }
  }
}

@media (prefers-reduced-motion: reduce) {
  .asp__tab { transition: none; }
}
</style>

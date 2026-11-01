<script lang="ts">
// Filter strip for the applications list: one chip per stage with its count.
// "Needs you" comes first because it is the only stage that waits on Devin.
export type StageKey = 'all' | 'needs_you' | 'decide' | 'working' | 'sent' | 'closed'

export const STAGES: Array<{ key: StageKey; label: string; statuses: string[] }> = [
  { key: 'all', label: 'All', statuses: [] },
  { key: 'needs_you', label: 'Needs you', statuses: ['needs_input', 'needs_manual', 'submit_failed'] },
  { key: 'decide', label: 'Ready to decide', statuses: ['proposed'] },
  { key: 'working', label: 'In progress', statuses: ['preparing', 'approved', 'publishing', 'submitting'] },
  { key: 'sent', label: 'Submitted', statuses: ['submitted', 'response_received', 'interviewing', 'offer'] },
  { key: 'closed', label: 'Closed', statuses: ['declined', 'rejected', 'draft', 'ready'] },
]
</script>

<script setup lang="ts">
const props = defineProps<{ counts: Record<StageKey, number>; modelValue: StageKey }>()
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

<script setup lang="ts">
import { clockTime } from '~/composables/review/format'

// Pipeline health, kept small: did the last run work, how much of today's AI budget is gone,
// and how many questions are waiting. Detail lives in Settings and on the Questions page.
const props = withDefaults(defineProps<{
  /** inline: one tappable line that opens the detail (phones). panel: always open (desktop). */
  variant?: 'panel' | 'inline'
}>(), { variant: 'panel' })

const health = usePipelineHealth()
const open = ref(props.variant === 'panel')

const run = computed(() => health.lastRun.value)
const runTone = computed(() => {
  const s = run.value?.status
  return s === 'succeeded' ? 'success' : s === 'failed' ? 'error' : s === 'running' ? 'info' : 'secondary'
})
const runLabel = computed(() => {
  const r = run.value
  if (!r) return 'No pipeline runs yet'
  const what = r.task === 'pipeline:daily' ? 'Daily run' : r.task
  const verb = { succeeded: 'succeeded', failed: 'failed', running: 'running', skipped: 'skipped' }[r.status] ?? r.status
  return `${what} ${verb}`
})
const runError = computed(() => run.value?.status === 'failed' ? (run.value.error ?? '').split('\n')[0]!.slice(0, 160) : null)

const spent = computed(() => health.runs.value?.aiSpentToday ?? 0)
const budget = computed(() => health.runs.value?.aiBudget ?? 0)
const spentPct = computed(() => (budget.value > 0 ? Math.min(100, (spent.value / budget.value) * 100) : 0))
const spendTone = computed(() => (spentPct.value >= 90 ? 'error' : spentPct.value >= 70 ? 'warning' : 'primary'))

const pending = computed(() => health.stats.value?.questions.pending ?? 0)
const blocking = computed(() => health.stats.value?.questions.blocking ?? 0)

const inlineSummary = computed(() => {
  const parts = [run.value ? `${runLabel.value} ${clockTime(run.value.startedAt)}` : 'No runs yet']
  parts.push(`$${spent.value.toFixed(2)} of $${budget.value.toFixed(0)} AI`)
  if (pending.value) parts.push(`${pending.value} question${pending.value === 1 ? '' : 's'}`)
  return parts.join(' · ')
})
</script>

<template>
  <div class="hl" :class="`hl--${variant}`">
    <button
      v-if="variant === 'inline'"
      type="button"
      class="hl__toggle"
      :aria-expanded="open"
      aria-controls="pipeline-health"
      @click="open = !open"
    >
      <span class="hl__dot" :class="`bg-${runTone}`" />
      <span class="hl__toggle-text">{{ inlineSummary }}</span>
      <v-icon :icon="open ? 'mdi-chevron-up' : 'mdi-chevron-down'" size="18" />
    </button>

    <v-expand-transition>
      <div v-show="open" id="pipeline-health" class="hl__body">
        <div v-if="health.error.value" class="hl__err" role="alert">{{ health.error.value }}</div>

        <div class="hl__row">
          <span class="hl__dot" :class="`bg-${runTone}`" />
          <div class="hl__text">
            <div class="hl__strong">{{ runLabel }}</div>
            <div v-if="run" class="hl__muted">
              {{ clockTime(run.startedAt) }}{{ run.host ? ` on ${run.host}` : '' }}
            </div>
            <div v-if="runError" class="hl__error-line">{{ runError }}</div>
          </div>
          <NuxtLink to="/settings#pipeline" class="hl__link">Runs</NuxtLink>
        </div>

        <div class="hl__row">
          <v-icon icon="mdi-robot-outline" size="16" class="hl__icon" />
          <div class="hl__text">
            <div class="hl__strong">${{ spent.toFixed(2) }} <span class="hl__muted">of ${{ budget.toFixed(2) }} AI budget today</span></div>
            <div class="hl__meter" role="meter" :aria-valuenow="Math.round(spentPct)" aria-valuemin="0" aria-valuemax="100" aria-label="AI budget used today">
              <span :class="`bg-${spendTone}`" :style="{ width: `${spentPct}%` }" />
            </div>
          </div>
        </div>

        <div class="hl__row">
          <v-icon icon="mdi-comment-question-outline" size="16" class="hl__icon" />
          <div class="hl__text">
            <div class="hl__strong">
              <span class="tabular">{{ pending }}</span> question{{ pending === 1 ? '' : 's' }} waiting
              <span v-if="blocking" class="text-warning">({{ blocking }} blocking)</span>
            </div>
            <div class="hl__links">
              <NuxtLink to="/questions" class="hl__link">Questions</NuxtLink>
              <NuxtLink to="/learning" class="hl__link">Learning</NuxtLink>
            </div>
          </div>
        </div>
      </div>
    </v-expand-transition>
  </div>
</template>

<style scoped lang="scss">
.hl {
  &--panel {
    padding: 12px;
    border-radius: 10px;
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    background: rgb(var(--v-theme-surface));
  }

  &--inline {
    border-radius: 8px;
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    background: rgb(var(--v-theme-surface));
  }

  &__toggle {
    width: 100%;
    min-height: 44px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    color: inherit;
    text-align: left;
  }

  &__toggle-text {
    flex: 1;
    min-width: 0;
    font-size: 0.75rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &--inline &__body {
    padding: 0 12px 12px;
  }

  &__body {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  &__row {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }

  &__dot {
    width: 8px;
    height: 8px;
    border-radius: 2px;
    flex-shrink: 0;
    margin: 6px 4px 0;
  }

  &__toggle &__dot {
    margin: 0;
  }

  &__icon {
    margin-top: 1px;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__text {
    flex: 1;
    min-width: 0;
  }

  &__strong {
    font-size: 0.8125rem;
    font-weight: 600;
  }

  &__muted {
    font-size: 0.75rem;
    font-weight: 400;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    overflow-wrap: anywhere;
  }

  &__error-line {
    margin-top: 2px;
    font-size: 0.75rem;
    color: rgb(var(--v-theme-error));
    overflow-wrap: anywhere;
  }

  &__meter {
    margin-top: 6px;
    height: 4px;
    border-radius: 2px;
    overflow: hidden;
    background: rgba(var(--v-theme-on-surface), 0.08);

    span {
      display: block;
      height: 100%;
    }
  }

  &__links {
    display: flex;
    gap: 14px;
    margin-top: 2px;
  }

  &__link {
    font-size: 0.75rem;
    font-weight: 600;
    color: rgb(var(--v-theme-primary));
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    min-height: 24px;

    &:hover {
      text-decoration: underline;
    }
  }

  &--inline &__link {
    min-height: 44px;
    padding: 0 4px;
  }

  &__err {
    font-size: 0.75rem;
    color: rgb(var(--v-theme-error));
  }
}
</style>

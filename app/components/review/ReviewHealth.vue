<script setup lang="ts">
import { OUTCOME, clockTime, outcomeOf } from '~/composables/review/format'
import { plainError } from '#shared/utils/plain-text'
import { taskLabel } from '#shared/utils/run-outcome'
import { bulkText, queueItemName, queueItemText } from '#shared/utils/queue-text'
import { appLimitPauseText, subscriptionPauseText } from '#shared/utils/subscription'

// Pipeline health, kept small: did the last run work, how much of today's Claude limit is gone,
// and how many questions are waiting. Detail lives in Settings and on the Questions page.
const props = withDefaults(defineProps<{
  /** inline: one tappable line that opens the detail (phones). panel: always open (desktop). */
  variant?: 'panel' | 'inline'
}>(), { variant: 'panel' })

const health = usePipelineHealth()
const open = ref(props.variant === 'panel')

const run = computed(() => health.lastRun.value)
// The server sends a plain sentence for every kind of account problem (out of credit, key rejected).
const aiProblem = computed(() => health.runs.value?.aiProblem ?? null)
const outcome = computed(() => (run.value ? outcomeOf(run.value) : null))
const runTone = computed(() => (outcome.value ? OUTCOME[outcome.value].color : 'secondary'))
const runLabel = computed(() => {
  const r = run.value
  if (!r || !outcome.value) return 'No pipeline runs yet'
  const what = r.task === 'pipeline:daily' ? 'Full run' : taskLabel(r.task)
  return `${what} ${OUTCOME[outcome.value].label}`
})
const problems = computed(() => (outcome.value === 'partial' ? run.value?.problems ?? [] : []))
const runError = computed(() => (outcome.value === 'failed' ? plainError(run.value?.error) : null))

// Steps run on Devin's Claude subscription while its token is set; while its limit holds, they
// wait for the reset and this says until when, in amber.
const subscription = computed(() => health.runs.value?.subscription ?? null)
const onSubscription = computed(() => !!subscription.value?.on)
const pausedText = computed(() => (subscription.value?.pause ? subscriptionPauseText(subscription.value.pause.until) : null))
// This app's own limit on the subscription: in amber while it stops background work (its share of
// the daily limit) or every call (the daily or 7-day limit).
const limitText = computed(() => {
  const stop = subscription.value?.stop
  return stop ? appLimitPauseText(stop.kind, stop.until, { sharePct: stop.sharePct }) : null
})

// On the subscription the meter is today's estimate against this app's daily limit; on the API key,
// today's spend against the key's budget.
const subLimits = computed(() => (onSubscription.value ? subscription.value?.limits ?? null : null))
const subSpent = computed(() => subscription.value?.spent ?? null)
const spent = computed(() => (subLimits.value ? subSpent.value?.today.estUsd ?? 0 : health.runs.value?.aiSpentToday ?? 0))
const budget = computed(() => (subLimits.value ? subLimits.value.dailyUsd : health.runs.value?.aiBudget ?? 0))
const spentPct = computed(() => (budget.value > 0 ? Math.min(100, (spent.value / budget.value) * 100) : 0))
const warnAt = computed(() => subLimits.value?.backgroundSharePct ?? 70)
const spendTone = computed(() => (spentPct.value >= (subLimits.value ? 100 : 90) ? 'error' : spentPct.value >= warnAt.value ? 'warning' : 'primary'))

const pending = computed(() => health.stats.value?.questions.pending ?? 0)
const blocking = computed(() => health.stats.value?.questions.blocking ?? 0)

// Closed, the line is a summary. Open, the body says everything, so the line becomes a plain
// heading instead of repeating (and cutting off) the same text above the detail.
const inlineSummary = computed(() => {
  if (open.value) return 'Pipeline health'
  if (aiProblem.value) return aiProblem.value.message
  if (pausedText.value) return pausedText.value
  if (limitText.value) return limitText.value
  const parts = [run.value ? `${runLabel.value} ${clockTime(run.value.startedAt)}` : 'No runs yet']
  parts.push(subLimits.value ? `est. $${spent.value.toFixed(2)} of $${budget.value.toFixed(0)} Claude` : `$${spent.value.toFixed(2)} of $${budget.value.toFixed(0)} AI`)
  if (pending.value) parts.push(`${pending.value} question${pending.value === 1 ? '' : 's'}`)
  return parts.join(' · ')
})
const summaryTone = computed(() => (aiProblem.value ? 'error' : pausedText.value || limitText.value ? 'warning' : runTone.value))

// The job queue in one or two lines: what runs now and what waits, or an approval a restart
// interrupted today. The clock ticks so "queued 2 minutes ago" stays true between refreshes.
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | null = null
let stopWatching: (() => void) | null = null
onMounted(() => {
  clock = setInterval(() => (now.value = Date.now()), 20_000)
  stopWatching = health.watchQueue()
})
onBeforeUnmount(() => {
  if (clock) clearInterval(clock)
  stopWatching?.()
})
const queueLine = computed<{ title: string; sub: string | null; tone: string } | null>(() => {
  const q = health.runs.value?.queue
  if (!q) return null
  const t = now.value
  const [running] = q.running
  const waiting = running ? q.waiting : q.waiting.slice(1)
  const waitingLine = waiting.length
    ? `Waiting: ${queueItemName(waiting[0]!)}${waiting.length > 1 ? ` and ${waiting.length - 1} more` : ''}`
    : null
  const bulk = (q.bulk ?? []).map(bulkText).join('. ')
  const more = [bulk || null, waitingLine].filter(Boolean).join('. ') || null
  if (running) return { title: queueItemText(running, t), sub: more, tone: 'info' }
  if (q.waiting[0]) return { title: queueItemText(q.waiting[0], t), sub: more, tone: 'secondary' }
  if (bulk) return { title: bulk, sub: null, tone: 'info' }
  const interrupted = q.recent.find(i => i.status === 'interrupted')
  if (interrupted) return { title: queueItemText(interrupted, t), sub: null, tone: 'error' }
  return null
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
      <span class="hl__dot" :class="`bg-${summaryTone}`" />
      <span class="hl__toggle-text" :class="{ 'hl__toggle-text--open': open }">{{ inlineSummary }}</span>
      <v-icon :icon="open ? 'mdi-chevron-up' : 'mdi-chevron-down'" size="18" />
    </button>

    <v-expand-transition>
      <div v-show="open" id="pipeline-health" class="hl__body">
        <div v-if="health.error.value" class="hl__err" role="alert">{{ health.error.value }}</div>
        <div v-if="aiProblem" class="hl__err" role="alert">
          {{ aiProblem.message }} Last refused {{ clockTime(aiProblem.since) }}.
        </div>
        <div v-if="pausedText" class="hl__paused" role="status">
          <v-icon icon="mdi-pause-circle-outline" size="16" class="hl__paused-icon" />
          <span>{{ pausedText }}</span>
        </div>
        <div v-if="limitText" class="hl__paused" role="status">
          <v-icon icon="mdi-pause-circle-outline" size="16" class="hl__paused-icon" />
          <span>{{ limitText }}</span>
        </div>

        <div class="hl__row">
          <span class="hl__dot" :class="`bg-${runTone}`" />
          <div class="hl__text">
            <div class="hl__strong">{{ runLabel }}</div>
            <div v-if="run" class="hl__muted">
              {{ clockTime(run.startedAt) }}{{ run.host ? ` on ${run.host}` : '' }}
            </div>
            <ul v-if="problems.length" class="hl__problems">
              <li v-for="p in problems.slice(0, 4)" :key="p">{{ p }}</li>
              <li v-if="problems.length > 4">and {{ problems.length - 4 }} more in Settings > Pipeline</li>
            </ul>
            <div v-if="runError" class="hl__error-line">{{ runError }}</div>
          </div>
          <NuxtLink to="/settings/pipeline#runs" class="hl__link">Runs</NuxtLink>
        </div>

        <div v-if="queueLine" class="hl__row" role="status" aria-live="polite">
          <span class="hl__dot" :class="`bg-${queueLine.tone}`" />
          <div class="hl__text">
            <div class="hl__strong">{{ queueLine.title }}</div>
            <div v-if="queueLine.sub" class="hl__muted">{{ queueLine.sub }}</div>
          </div>
          <NuxtLink to="/settings/pipeline#queue" class="hl__link">Queue</NuxtLink>
        </div>

        <div class="hl__row">
          <v-icon icon="mdi-robot-outline" size="16" class="hl__icon" />
          <div class="hl__text">
            <div v-if="subLimits" class="hl__strong">est. ${{ spent.toFixed(2) }} <span class="hl__muted">of ${{ budget.toFixed(2) }} daily Claude limit today</span></div>
            <div v-else class="hl__strong">${{ spent.toFixed(2) }} <span class="hl__muted">of ${{ budget.toFixed(2) }} AI budget today</span></div>
            <div class="hl__meter" role="meter" :aria-valuenow="Math.round(spentPct)" aria-valuemin="0" aria-valuemax="100" :aria-label="subLimits ? 'Daily Claude limit used today' : 'AI budget used today'">
              <span :class="`bg-${spendTone}`" :style="{ width: `${spentPct}%` }" />
            </div>
            <div v-if="subLimits && subSpent" class="hl__muted">est. ${{ subSpent.week.estUsd.toFixed(2) }} of ${{ subLimits.weekUsd.toFixed(2) }} in the last 7 days</div>
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

    &--open {
      font-weight: 600;
      color: rgb(var(--v-theme-on-surface));
    }
  }

  &__problems {
    margin: 4px 0 0;
    padding-left: 16px;
    font-size: 0.75rem;
    color: rgb(var(--v-theme-warning));
    overflow-wrap: anywhere;
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

  // Phone shell, either variant (the empty queue shows the panel on a phone too): 44px targets.
  &--inline &__link {
    min-height: 44px;
    min-width: 44px;
    justify-content: center;
    padding: 0 4px;
  }

  @media (max-width: 959.98px) {
    &__link {
      min-height: 44px;
      min-width: 44px;
      justify-content: center;
      padding: 0 4px;
    }
  }

  &__err {
    font-size: 0.75rem;
    color: rgb(var(--v-theme-error));
    overflow-wrap: anywhere;
  }

  &__paused {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid rgba(var(--v-theme-warning), 0.45);
    background: rgba(var(--v-theme-warning), 0.08);
    color: rgb(var(--v-theme-warning));
    font-size: 0.8125rem;
    font-weight: 600;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }

  &__paused-icon {
    flex: none;
    margin-top: 1px;
  }
}
</style>

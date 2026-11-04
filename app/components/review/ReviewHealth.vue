<script setup lang="ts">
import { OUTCOME, clockTime, outcomeOf } from '~/composables/review/format'
import { plainError } from '#shared/utils/plain-text'
import { taskLabel } from '#shared/utils/run-outcome'
import { bulkText, queueItemName, queueItemText } from '#shared/utils/queue-text'
import { appLimitPauseText, subscriptionPauseText } from '#shared/utils/subscription'

// Pipeline health, folded to one line above the queue so the list starts near the top: the line
// names the state that matters most (an account problem, a pause, a limit, an interrupted
// approval, else the last run) in its color, keeps the Runs and Queue links, and opens the detail
// on click. Detail lives in Settings and on the Questions page.
const props = withDefaults(defineProps<{
  /** line: one line that opens the detail (the queue, desktop and phone). panel: always open (empty queue). */
  variant?: 'panel' | 'line' | 'inline'
}>(), { variant: 'line' })

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
const interruptedApproval = computed(() => health.runs.value?.queue?.recent.find(i => i.status === 'interrupted') ?? null)
const lineSummary = computed(() => {
  if (open.value) return 'Pipeline'
  if (aiProblem.value) return aiProblem.value.message
  if (pausedText.value) return pausedText.value
  if (limitText.value) return limitText.value
  if (interruptedApproval.value) return queueItemText(interruptedApproval.value, now.value)
  return run.value ? `${runLabel.value}, ${clockTime(run.value.startedAt)}` : 'No runs yet'
})
const summaryTone = computed(() => {
  if (aiProblem.value || interruptedApproval.value) return 'error'
  if (pausedText.value || limitText.value) return 'warning'
  return runTone.value
})
/** The line's text takes the state's color only for a stop or a failure, not for a routine run. */
const lineTone = computed(() => (open.value ? 'neutral' : summaryTone.value === 'error' || summaryTone.value === 'warning' ? summaryTone.value : 'neutral'))

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
    <div v-if="variant !== 'panel'" class="hl__line">
      <button
        type="button"
        class="hl__toggle"
        :aria-expanded="open"
        aria-controls="pipeline-health"
        :title="open ? undefined : lineSummary"
        @click="open = !open"
      >
        <span class="hl__dot" :class="`bg-${summaryTone}`" />
        <span class="hl__toggle-text" :class="[`hl__toggle-text--${lineTone}`, { 'hl__toggle-text--open': open }]">{{ lineSummary }}</span>
        <v-icon :icon="open ? 'mdi-chevron-up' : 'mdi-chevron-down'" size="18" class="hl__chev" />
      </button>
      <NuxtLink to="/settings/pipeline#runs" class="hl__link hl__link--line">Runs</NuxtLink>
      <NuxtLink to="/settings/pipeline#queue" class="hl__link hl__link--line">Queue</NuxtLink>
    </div>

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
              <span class="tabular">{{ pending.toLocaleString('en-US') }}</span> question{{ pending === 1 ? '' : 's' }} waiting<template v-if="blocking">, <span class="text-warning">{{ blocking.toLocaleString('en-US') }} blocking an approval</span></template>
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
    padding: 16px;
    border-radius: 16px;
    background: rgb(var(--v-theme-surface));
  }

  // The folded line: 40px on the ground, no box. Opening it lays the detail on a card below.
  &__line {
    display: flex;
    align-items: center;
    gap: 2px;
    min-height: 40px;
  }

  &__toggle {
    flex: 1;
    min-width: 0;
    min-height: 40px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 8px;
    margin-left: -8px;
    border-radius: 8px;
    color: inherit;
    text-align: left;

    &:hover {
      background: rgb(var(--v-theme-surface));
    }
  }

  &__toggle-text {
    flex: 1;
    min-width: 0;
    font-size: 0.8125rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));

    &--warning {
      color: rgb(var(--v-theme-warning));
      font-weight: 500;
    }

    &--error {
      color: rgb(var(--v-theme-error));
      font-weight: 500;
    }

    &--open {
      font-weight: 600;
      color: rgb(var(--v-theme-on-surface));
    }
  }

  &__chev {
    flex: none;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__problems {
    margin: 4px 0 0;
    padding-left: 16px;
    font-size: 0.75rem;
    color: rgb(var(--v-theme-warning));
    overflow-wrap: anywhere;
  }

  &__body {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  &--line &__body,
  &--inline &__body {
    margin-top: 4px;
    padding: 14px;
    border-radius: 10px;
    background: rgb(var(--v-theme-surface));
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
    background: rgb(var(--v-theme-surface-light));

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

  // Links read in ink, underlined on hover.
  &__link {
    font-size: 0.8125rem;
    font-weight: 500;
    color: rgb(var(--v-theme-on-surface));
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    min-height: 24px;

    &:hover {
      text-decoration: underline;
    }

    &--line {
      flex: none;
      min-height: 40px;
      padding: 0 6px;
    }
  }

  @media (max-width: 959.98px) {
    &__line,
    &__toggle {
      min-height: 44px;
    }

    &__link {
      min-height: 44px;
      min-width: 44px;
      justify-content: center;
      padding: 0 4px;
    }
  }

  &__err {
    font-size: 0.8125rem;
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
    font-weight: 500;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }

  &__paused-icon {
    flex: none;
    margin-top: 1px;
  }
}
</style>

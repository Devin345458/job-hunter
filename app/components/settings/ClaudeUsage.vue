<script setup lang="ts">
import { appLimitPauseText, subscriptionPauseText } from '#shared/utils/subscription'
import type { SubscriptionStatus } from '#shared/types/pipeline'

// Settings > Claude usage: what Claude has cost (the subscription estimate today and over 7 days,
// and the API key's dollars), this app's two limits on the subscription with the fields that set
// them, and the stage table that says which part of the pipeline spent it. It was the top half of
// the Pipeline panel until 2026-11-04; the data still comes from GET /api/pipeline/runs.
const health = usePipelineHealth()
const snackbar = useSnackbar()

const spent = computed(() => health.runs.value?.aiSpentToday ?? 0)
const budget = computed(() => health.runs.value?.aiBudget ?? 0)
const spentPct = computed(() => (budget.value > 0 ? Math.min(100, (spent.value / budget.value) * 100) : 0))
const overBudget = computed(() => budget.value > 0 && spent.value >= budget.value)

// Devin's Claude subscription: steps run on it while its token is set, and the dollar budget then
// covers only steps left on the API key. While its limit holds, Claude steps wait for the reset.
const subscription = computed(() => health.runs.value?.subscription ?? null)
const onSubscription = computed(() => !!subscription.value?.on)
const pausedText = computed(() => (subscription.value?.pause ? subscriptionPauseText(subscription.value.pause.until) : null))

// This app's own limits on the subscription, in estimated dollars: per day and over 7 days.
// Background work stops at the share marked on the daily bar; at either limit every call stops.
const limits = computed(() => subscription.value?.limits ?? null)
const subSpent = computed(() => subscription.value?.spent ?? null)
const showSubscription = computed(() => !!limits.value && (onSubscription.value || (subSpent.value?.week.calls ?? 0) > 0))
/** The API key line shows when steps run on the key, or a key is set beside the subscription. */
const showApiLine = computed(() => !onSubscription.value || !!subscription.value?.apiKey)
const sharePct = computed(() => limits.value?.backgroundSharePct ?? 70)
const limitText = computed(() => {
  const stop = subscription.value?.stop
  return stop ? appLimitPauseText(stop.kind, stop.until, { sharePct: stop.sharePct }) : null
})
const pct = (spent: number, limit: number) => (limit > 0 ? Math.min(100, (spent / limit) * 100) : 0)
const todayPct = computed(() => pct(subSpent.value?.today.estUsd ?? 0, limits.value?.dailyUsd ?? 0))
const weekPct = computed(() => pct(subSpent.value?.week.estUsd ?? 0, limits.value?.weekUsd ?? 0))
const todayTone = computed(() => (todayPct.value >= 100 ? 'bg-error' : todayPct.value >= sharePct.value ? 'bg-warning' : 'bg-primary'))
const weekTone = computed(() => (weekPct.value >= 100 ? 'bg-error' : weekPct.value >= 80 ? 'bg-warning' : 'bg-primary'))

const dailyInput = ref('')
const weekInput = ref('')
const savingLimits = ref(false)
function limitError(raw: string, label: string): string | null {
  const n = Number(raw)
  if (!String(raw).trim() || !Number.isFinite(n) || n <= 0) return `Enter the ${label} in dollars, above $0`
  if (n > 10_000) return `The ${label} can be at most $10,000`
  return null
}
const dailyError = computed(() => limitError(dailyInput.value, 'daily limit'))
const weekError = computed(() => limitError(weekInput.value, '7-day limit'))
/** An input differs from the saved limit (an empty or unreadable one counts as changed). */
const differs = (raw: string, saved: number) => !String(raw).trim() || !(Math.abs(Number(raw) - saved) < 0.005)
const limitsDirty = computed(() => {
  const l = limits.value
  return !!l && (differs(dailyInput.value, l.dailyUsd) || differs(weekInput.value, l.weekUsd))
})
/** The inputs follow the server until Devin edits them. */
watch(limits, (l, before) => {
  if (!l || savingLimits.value) return
  const edited = before && (differs(dailyInput.value, before.dailyUsd) || differs(weekInput.value, before.weekUsd))
  if (!edited) {
    dailyInput.value = l.dailyUsd.toFixed(2)
    weekInput.value = l.weekUsd.toFixed(2)
  }
}, { immediate: true })

async function saveLimits() {
  if (dailyError.value || weekError.value) return
  savingLimits.value = true
  try {
    const res = await $fetch<{ subscription: SubscriptionStatus; released: number }>('/api/settings/subscription-limits', {
      method: 'PUT',
      body: { dailyUsd: Number(dailyInput.value), weekUsd: Number(weekInput.value) },
    })
    if (health.runs.value) health.runs.value = { ...health.runs.value, subscription: res.subscription }
    dailyInput.value = res.subscription.limits.dailyUsd.toFixed(2)
    weekInput.value = res.subscription.limits.weekUsd.toFixed(2)
    snackbar.info(res.released ? `Limits saved. ${res.released} paused ${res.released === 1 ? 'item runs' : 'items run'} again.` : 'Limits saved')
    if (res.released) void health.follow()
  }
  catch (e: any) {
    snackbar.notify(`Limits not saved: ${e?.data?.statusMessage || e?.message || 'unknown error'}`, 'error', { timeout: -1 })
  }
  finally {
    savingLimits.value = false
  }
}

// Where the money went: before Devin decides (every job) and after Apply (only jobs he chose).
const stages = computed(() => health.runs.value?.aiStages ?? null)
const STAGE_PHASES = [
  { phase: 'before', label: 'Before you decide, for every job' },
  { phase: 'after', label: 'After you tap Apply, only for jobs you chose' },
  { phase: 'other', label: 'Other' },
] as const
const stageGroups = computed(() => STAGE_PHASES
  .map(p => ({ ...p, rows: (stages.value?.stages ?? []).filter(s => s.phase === p.phase) }))
  .filter(g => g.rows.length))
const usd = (n: number) => `$${n.toFixed(2)}`
// Each row adds API dollars and the subscription estimate; a column with any subscription call in it
// says "est." so it reads as the estimate the bar above shows.
const todayEstimated = computed(() => (stages.value?.stages ?? []).some(s => (s.today.subscriptionCalls ?? 0) > 0))
const weekEstimated = computed(() => (stages.value?.stages ?? []).some(s => (s.week.subscriptionCalls ?? 0) > 0))
/** "3 applications chosen with Apply in the last 7 days; preparing them cost $1.23, about $0.41 each." */
const perApplication = computed(() => {
  const n = stages.value?.appliedThisWeek ?? 0
  const prep = stages.value?.appliedPrepareUsd ?? 0
  if (!n) return 'No Apply in the last 7 days.'
  return `${n} ${n === 1 ? 'application' : 'applications'} chosen with Apply in the last 7 days; preparing ${n === 1 ? 'it' : 'them'} cost ${usd(prep)}, about ${usd(prep / n)} each.`
})
const callCount = (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'call' : 'calls'}`

onMounted(() => {
  // The spend climbs while items run, so follow the queue as Settings > Pipeline does.
  health.refresh(30).then(() => {
    if (health.queueBusy.value || (health.runs.value?.runs ?? []).some(r => r.status === 'running')) void health.follow()
  })
})
</script>

<template>
  <div class="cu">
    <v-progress-linear v-if="!health.runs.value && health.loading.value" indeterminate color="primary" class="mb-4" />
    <p v-if="health.error.value" class="cu__err" role="alert">{{ health.error.value }}</p>

    <p v-if="pausedText" class="cu__paused" role="status">
      <v-icon icon="mdi-pause-circle-outline" size="18" class="cu__paused-icon" />
      <span>{{ pausedText }}</span>
    </p>
    <p v-if="limitText" class="cu__paused" role="status">
      <v-icon icon="mdi-pause-circle-outline" size="18" class="cu__paused-icon" />
      <span>{{ limitText }}</span>
    </p>

    <v-card v-if="showSubscription && limits && subSpent" variant="outlined" class="cu__card" aria-label="Claude subscription limits" tag="section">
      <v-card-item>
        <v-card-title class="text-subtitle-1 font-weight-medium">Claude subscription</v-card-title>
      </v-card-item>
      <v-card-text>
        <div class="cu__text cu__text--lead">
          est. <span class="cu__strong tabular">{{ usd(subSpent.today.estUsd) }}</span> of {{ usd(limits.dailyUsd) }} today,
          <span class="cu__strong tabular">{{ usd(subSpent.week.estUsd) }}</span> of {{ usd(limits.weekUsd) }} in the last 7 days
        </div>
        <div class="cu__bars">
          <div class="cu__bar-row">
            <span class="cu__bar-label">Today</span>
            <div class="cu__meter cu__meter--bar" role="meter" :aria-valuenow="Math.round(todayPct)" aria-valuemin="0" aria-valuemax="100" aria-label="Daily Claude limit used">
              <span :class="todayTone" :style="{ width: `${todayPct}%` }" />
              <i class="cu__tick" :style="{ left: `${sharePct}%` }" aria-hidden="true" />
            </div>
            <span class="cu__bar-num tabular">{{ callCount(subSpent.today.calls) }}</span>
          </div>
          <div class="cu__bar-row">
            <span class="cu__bar-label">Last 7 days</span>
            <div class="cu__meter cu__meter--bar" role="meter" :aria-valuenow="Math.round(weekPct)" aria-valuemin="0" aria-valuemax="100" aria-label="7-day Claude limit used">
              <span :class="weekTone" :style="{ width: `${weekPct}%` }" />
            </div>
            <span class="cu__bar-num tabular">{{ callCount(subSpent.week.calls) }}</span>
          </div>
        </div>
        <p class="cu__note">
          Background work (scheduled steps, reading and scoring jobs) stops at {{ sharePct }}% of the daily limit, the mark on the bar. What you start yourself can use the rest. At either limit every Claude call stops until midnight, or until the 7-day total drops under it. Amounts are Claude Code's estimate of what each call would cost on the API.
        </p>
        <form class="cu__limits" novalidate @submit.prevent="saveLimits">
          <div class="field-wrap">
            <label class="field-label" for="cu-limit-0">Daily limit</label>
            <v-text-field
              v-model="dailyInput"
              id="cu-limit-0"
              prefix="$"
              type="number"
              inputmode="decimal"
              min="0.01"
              step="0.5"
              density="compact"
              variant="outlined"
              hide-details="auto"
              :error-messages="limitsDirty && dailyError ? [dailyError] : []"
              class="cu__limit"
            />
          </div>
          <div class="field-wrap">
            <label class="field-label" for="cu-limit-1">7-day limit</label>
            <v-text-field
              v-model="weekInput"
              id="cu-limit-1"
              prefix="$"
              type="number"
              inputmode="decimal"
              min="0.01"
              step="1"
              density="compact"
              variant="outlined"
              hide-details="auto"
              :error-messages="limitsDirty && weekError ? [weekError] : []"
              class="cu__limit"
            />
          </div>
          <v-btn type="submit" variant="flat" color="primary" height="40" :loading="savingLimits" :disabled="!limitsDirty || !!dailyError || !!weekError">Save limits</v-btn>
          <span v-if="!limitsDirty" class="cu__save-why">Change a limit to save it</span>
        </form>
      </v-card-text>
    </v-card>

    <v-card v-if="health.runs.value && showApiLine" variant="outlined" class="cu__card" tag="section" aria-label="API key budget">
      <v-card-item>
        <v-card-title class="text-subtitle-1 font-weight-medium">{{ onSubscription ? 'API key' : 'AI budget' }}</v-card-title>
      </v-card-item>
      <v-card-text>
        <div class="cu__text">
          <span class="cu__strong">${{ spent.toFixed(2) }}</span>
          of ${{ budget.toFixed(2) }} {{ onSubscription ? 'API key budget' : 'AI budget' }} spent today<span v-if="overBudget" class="text-error">. Steps that use {{ onSubscription ? 'the API key' : 'Claude' }} stop until midnight</span>.<span v-if="onSubscription"> Only steps mapped to the API key count against it.</span>
        </div>
        <div class="cu__meter" role="meter" :aria-valuenow="Math.round(spentPct)" aria-valuemin="0" aria-valuemax="100" aria-label="AI budget used today">
          <span :class="overBudget ? 'bg-error' : spentPct >= 70 ? 'bg-warning' : 'bg-primary'" :style="{ width: `${spentPct}%` }" />
        </div>
      </v-card-text>
    </v-card>

    <v-card v-if="stages" variant="outlined" class="cu__card" tag="section" aria-label="AI spend by stage">
      <v-card-item>
        <v-card-title class="text-subtitle-1 font-weight-medium">Where it went</v-card-title>
      </v-card-item>
      <v-card-text>
        <div class="cu__stages">
          <div class="cu__stages-row cu__stages-row--head">
            <span>Stage</span>
            <span class="cu__stages-num">{{ todayEstimated ? 'Today, est.' : 'Today' }}</span>
            <span class="cu__stages-num">{{ weekEstimated ? 'Last 7 days, est.' : 'Last 7 days' }}</span>
          </div>
          <template v-for="g in stageGroups" :key="g.phase">
            <div class="cu__stages-phase">{{ g.label }}</div>
            <div v-for="s in g.rows" :key="s.key" class="cu__stages-row" :title="s.purposes.length ? `Counts: ${s.purposes.join(', ')}` : undefined">
              <span class="cu__stages-name">{{ s.label }}</span>
              <span class="cu__stages-num tabular">{{ usd(s.today.costUsd) }}</span>
              <span class="cu__stages-num tabular">{{ usd(s.week.costUsd) }} <span class="cu__stages-calls">{{ s.week.calls.toLocaleString('en-US') }} {{ s.week.calls === 1 ? 'call' : 'calls' }}</span></span>
            </div>
            <p v-if="g.phase === 'after'" class="cu__stages-note">{{ perApplication }}</p>
          </template>
        </div>
      </v-card-text>
    </v-card>
  </div>
</template>

<style scoped lang="scss">
.cu {
  display: flex;
  flex-direction: column;
  gap: 16px;

  &__err {
    margin: 0;
    font-size: 0.8125rem;
    color: rgb(var(--v-theme-error));
  }

  &__paused {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin: 0;
    padding: 10px 12px;
    border-radius: 8px;
    border: 1px solid rgba(var(--v-theme-warning), 0.45);
    background: rgba(var(--v-theme-warning), 0.08);
    color: rgb(var(--v-theme-warning));
    font-size: 0.875rem;
    font-weight: 600;
    line-height: 1.4;
  }

  &__paused-icon {
    flex: none;
    margin-top: 1px;
  }

  &__card :deep(.v-card-title) {
    white-space: normal;
  }

  &__text {
    font-size: 0.875rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  // The card is titled Claude subscription, so its first line is the two figures, one step larger.
  &__text--lead {
    font-size: 0.9375rem;
  }

  &__strong {
    font-weight: 700;
    color: rgb(var(--v-theme-on-surface));
  }

  &__bars {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 14px 0 12px;
  }

  &__bar-row {
    display: grid;
    grid-template-columns: 88px minmax(0, 1fr) 96px;
    align-items: center;
    gap: 12px;
    font-size: 0.8125rem;
  }

  &__bar-label,
  &__bar-num {
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__bar-num {
    text-align: right;
  }

  &__meter {
    margin-top: 8px;
    height: 6px;
    border-radius: 3px;
    overflow: hidden;
    background: rgba(var(--v-theme-on-surface), 0.08);

    span {
      display: block;
      height: 100%;
    }

    // The subscription bars: in a row with their label, and room for the background share mark.
    &--bar {
      position: relative;
      margin-top: 0;
      height: 8px;
      overflow: visible;

      span {
        border-radius: 3px;
      }
    }
  }

  &__tick {
    position: absolute;
    top: -2px;
    bottom: -2px;
    width: 2px;
    margin-left: -1px;
    background: rgba(var(--v-theme-on-surface), 0.55);
  }

  &__note {
    margin: 0 0 16px;
    max-width: 72ch;
    font-size: 0.8125rem;
    line-height: 1.5;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  // Labels above the fields; the button and its note sit on the fields' baseline.
  &__limits {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 12px 16px;

    > .field-wrap {
      flex: 0 0 160px;
    }
  }

  &__save-why {
    align-self: center;
    margin-top: 28px;
    font-size: 0.8125rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__stages {
    font-size: 0.8125rem;
  }

  &__stages-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 88px 168px;
    gap: 12px;
    padding: 4px 0;

    &--head {
      font-weight: 600;
      color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
      border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
      padding-bottom: 6px;
      margin-bottom: 2px;
    }
  }

  &__stages-name {
    padding-left: 12px;
  }

  &__stages-num {
    text-align: right;
  }

  &__stages-calls {
    display: inline-block;
    min-width: 64px;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__stages-phase {
    margin-top: 10px;
    font-weight: 600;
  }

  &__stages-note {
    margin: 2px 0 0 12px;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }
}

// Phone: the call counts drop under the bar, and the stage table keeps two number columns.
@media (max-width: 599.98px) {
  .cu__bar-row {
    grid-template-columns: 80px minmax(0, 1fr);
    row-gap: 2px;
  }

  // Both limits on one row, Save under them.
  .cu__limit {
    flex: 1 1 128px;
    max-width: none;
  }

  .cu__bar-num {
    grid-column: 2;
    text-align: left;
  }

  .cu__stages-row {
    grid-template-columns: minmax(0, 1fr) 64px 92px;
    gap: 8px;
  }

  .cu__stages-name {
    padding-left: 0;
  }

  .cu__stages-calls {
    display: block;
    min-width: 0;
  }
}
</style>

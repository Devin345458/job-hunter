<script setup lang="ts">
import { DAILY_STEPS, PIPELINE_SCHEDULE_TEXT, type DailyStep } from '#shared/utils/schedule'
import type { PipelineRunView, QueueItemView } from '#shared/types/pipeline'
import { OUTCOME, clockTime, outcomeOf, outcomeText, parseTime, runDemos, statsText } from '~/composables/review/format'
import { plainError } from '#shared/utils/plain-text'
import { taskLabel } from '#shared/utils/run-outcome'
import { bulkText, queueItemColor, queueItemText } from '#shared/utils/queue-text'

// Settings > Pipeline: start any step by hand, watch it wait in the job queue and run, and read
// the recent run log. Every trigger goes through POST /api/pipeline/run, which adds the task to
// the queue; the worker runs one item at a time, oldest first.
const health = usePipelineHealth()
const snackbar = useSnackbar()

interface TaskDef { id: string; label: string; detail: string; usesAi: boolean }
const STEP_DEFS: Record<DailyStep, Omit<TaskDef, 'id'>> = {
  'repos:index': { label: 'Index GitHub commits', detail: 'Reads your own commits in the repos switched on under GitHub evidence. Nothing is sent to Claude.', usesAi: false },
  'learn:daily': { label: 'Learn from decisions', detail: 'Turns your Apply and Reject decisions, and their reasons, into scoring rules.', usesAi: false },
  'jobs:search': { label: 'Search listings', detail: 'Pulls new postings from every active search.', usesAi: false },
  'jobs:enrich': { label: 'Read postings', detail: 'Fetches full postings, apply links, pay, and benefits.', usesAi: true },
  'jobs:match': { label: 'Score matches', detail: 'Scores skills and pay against your floor.', usesAi: true },
  'applications:read-forms': { label: 'Read forms for strong matches', detail: 'For jobs scoring 70 or more: the gap plan and a read of the employer form, so you can decide. The resume, letter, and answers are written only after you tap Apply.', usesAi: true },
  'demos:build': { label: 'Build demo projects', detail: 'Builds and tests demos for gaps. Nothing is published until you approve.', usesAi: true },
  'repos:suggest': { label: 'Suggest answers from GitHub', detail: 'Checks open skill and experience questions against your commits. Nothing is answered until you tap Use this and Save.', usesAi: true },
  'memory:leads': { label: 'Leads from your Claude sessions', detail: 'Searches your laptop\'s memory for leads on open questions. Skipped when it is not reachable.', usesAi: false },
}
/** The full run, then every step in the order the daily run runs them (DAILY_STEPS). */
const TASKS: TaskDef[] = [
  { id: 'pipeline:daily', label: 'Full run', detail: `Every step below, in order. This is what runs ${PIPELINE_SCHEDULE_TEXT}.`, usesAi: true },
  ...DAILY_STEPS.map(id => ({ id, ...STEP_DEFS[id] })),
]

const runs = computed<PipelineRunView[]>(() => health.runs.value?.runs ?? [])
const spent = computed(() => health.runs.value?.aiSpentToday ?? 0)
const budget = computed(() => health.runs.value?.aiBudget ?? 0)
const spentPct = computed(() => (budget.value > 0 ? Math.min(100, (spent.value / budget.value) * 100) : 0))
const overBudget = computed(() => budget.value > 0 && spent.value >= budget.value)

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
/** "3 applications chosen with Apply in the last 7 days; preparing them cost $1.23, about $0.41 each." */
const perApplication = computed(() => {
  const n = stages.value?.appliedThisWeek ?? 0
  const prep = stages.value?.appliedPrepareUsd ?? 0
  if (!n) return 'No Apply in the last 7 days.'
  return `${n} ${n === 1 ? 'application' : 'applications'} chosen with Apply in the last 7 days; preparing ${n === 1 ? 'it' : 'them'} cost ${usd(prep)}, about ${usd(prep / n)} each.`
})

function latest(task: string) {
  return runs.value.find(r => r.task === task) ?? null
}

const queue = computed(() => health.runs.value?.queue ?? null)
const queueRunning = computed<QueueItemView[]>(() => queue.value?.running ?? [])
const queueWaiting = computed<QueueItemView[]>(() => queue.value?.waiting ?? [])
const queueDaily = computed<QueueItemView[]>(() => queue.value?.runs ?? [])
const queueRecent = computed<QueueItemView[]>(() => queue.value?.recent ?? [])
const queueBulk = computed(() => queue.value?.bulk ?? [])
const queueEmpty = computed(() => !queueRunning.value.length && !queueWaiting.value.length && !queueDaily.value.length && !queueBulk.value.length)

/** 'running' or 'waiting' when this task is in the queue (a full run counts while its steps run). */
function queued(task: string): 'running' | 'waiting' | null {
  if (task === 'pipeline:daily' && queueDaily.value.length) return 'running'
  if (queueRunning.value.some(i => i.task === task && !i.parentId)) return 'running'
  if (queueWaiting.value.some(i => i.task === task && !i.parentId)) return 'waiting'
  return null
}

/** "Full run under way, step 4 of 9, started today 9:00 AM by the schedule". */
function dailyText(run: QueueItemView): string {
  const step = [...queueRunning.value, ...queueWaiting.value].find(i => i.parentId === run.id)?.step
  return `Full run under way${step ? `, step ${step.index} of ${step.total}` : ''}, started ${clockTime(run.startedAt)} by ${TRIGGER[run.trigger] ?? run.trigger}`
}

const starting = ref<string | null>(null)
const canceling = ref<number | null>(null)
const watching = ref(false)

async function start(task: TaskDef) {
  starting.value = task.id
  try {
    const res = await $fetch<{ queued: boolean }>('/api/pipeline/run', { method: 'POST', body: { task: task.id } })
    snackbar.info(res.queued ? `Queued: ${task.label}` : `${task.label} is already in the queue`)
    // Not awaited: the buttons free up at once, so more runs can be queued while this one waits.
    void follow()
  }
  catch (e: any) {
    snackbar.notify(`${task.label} was not queued: ${e?.data?.statusMessage || e?.message || 'unknown error'}`, 'error', { timeout: -1 })
  }
  finally {
    starting.value = null
  }
}

async function cancel(item: QueueItemView) {
  canceling.value = item.id
  try {
    await $fetch(`/api/pipeline/queue/${item.id}/cancel`, { method: 'POST' })
    snackbar.info(item.task === 'pipeline:daily' ? 'The rest of the full run is canceled. The step running now finishes.' : `Canceled: ${item.label}`)
    await health.refresh(30)
  }
  catch (e: any) {
    snackbar.notify(`Not canceled: ${e?.data?.statusMessage || e?.message || 'unknown error'}`, 'error', { timeout: -1 })
  }
  finally {
    canceling.value = null
  }
}

/** Refresh the queue and the run log while anything waits or runs, for up to 30 minutes. */
async function follow() {
  if (watching.value) return
  watching.value = true
  try {
    const until = Date.now() + 30 * 60_000
    await new Promise(r => setTimeout(r, 600))
    await health.refresh(30)
    while (Date.now() < until && (health.queueBusy.value || runs.value.some(r => r.status === 'running'))) {
      await new Promise(r => setTimeout(r, 2500))
      await health.refresh(30)
    }
  }
  finally {
    watching.value = false
  }
}

function duration(r: PipelineRunView) {
  const a = parseTime(r.startedAt)
  const b = parseTime(r.finishedAt)
  if (!a || !b) return r.status === 'running' ? 'running' : ''
  const s = Math.max(0, Math.round((b.getTime() - a.getTime()) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

const openRun = ref<number | null>(null)

const color = (r: PipelineRunView) => OUTCOME[outcomeOf(r)].color

const TRIGGER: Record<string, string> = { schedule: 'the schedule', manual: 'you', chained: 'the full run' }

const heartbeat = computed(() => health.runs.value?.lastHeartbeat ?? null)

onMounted(() => {
  health.refresh(30).then(() => {
    if (health.queueBusy.value || runs.value.some(r => r.status === 'running')) follow()
  })
})
</script>

<template>
  <div class="pp">
    <div class="pp__budget">
      <div class="pp__budget-text">
        <span class="pp__strong">${{ spent.toFixed(2) }}</span>
        of ${{ budget.toFixed(2) }} AI budget spent today
        <span v-if="overBudget" class="text-error">. Steps that use Claude stop until midnight.</span>
      </div>
      <div class="pp__meter" role="meter" :aria-valuenow="Math.round(spentPct)" aria-valuemin="0" aria-valuemax="100" aria-label="AI budget used today">
        <span :class="overBudget ? 'bg-error' : spentPct >= 70 ? 'bg-warning' : 'bg-primary'" :style="{ width: `${spentPct}%` }" />
      </div>
    </div>

    <div v-if="stages" class="pp__stages" aria-label="AI spend by stage">
      <div class="pp__stages-row pp__stages-row--head">
        <span>Where it went</span>
        <span class="pp__stages-num">Today</span>
        <span class="pp__stages-num">Last 7 days</span>
      </div>
      <template v-for="g in stageGroups" :key="g.phase">
        <div class="pp__stages-phase">{{ g.label }}</div>
        <div v-for="s in g.rows" :key="s.key" class="pp__stages-row" :title="s.purposes.length ? `Counts: ${s.purposes.join(', ')}` : undefined">
          <span class="pp__stages-name">{{ s.label }}</span>
          <span class="pp__stages-num tabular">{{ usd(s.today.costUsd) }}</span>
          <span class="pp__stages-num tabular">{{ usd(s.week.costUsd) }} <span class="pp__stages-calls">{{ s.week.calls }} {{ s.week.calls === 1 ? 'call' : 'calls' }}</span></span>
        </div>
        <p v-if="g.phase === 'after'" class="pp__stages-note">{{ perApplication }}</p>
      </template>
    </div>

    <ul class="pp__tasks">
      <li v-for="t in TASKS" :key="t.id" class="pp__task" :class="{ 'pp__task--main': t.id === 'pipeline:daily' }">
        <div class="pp__task-text">
          <div class="pp__task-name">
            {{ t.label }}
            <span v-if="t.usesAi" class="pp__ai">Uses AI budget</span>
          </div>
          <div class="pp__task-detail">{{ t.detail }}</div>
          <div class="pp__task-last">
            <template v-if="latest(t.id)">
              <span class="pp__dot" :class="`bg-${color(latest(t.id)!)}`" />
              Last run {{ clockTime(latest(t.id)!.startedAt) }}: {{ outcomeText(latest(t.id)!) }}
            </template>
            <template v-else>Not run yet</template>
          </div>
        </div>
        <v-btn
          :color="t.id === 'pipeline:daily' ? 'primary' : undefined"
          :variant="t.id === 'pipeline:daily' ? 'flat' : 'tonal'"
          height="44"
          min-width="96"
          :prepend-icon="queued(t.id) ? undefined : 'mdi-play'"
          :loading="starting === t.id || queued(t.id) === 'running'"
          :disabled="starting !== null || queued(t.id) !== null"
          :aria-label="queued(t.id) === 'waiting' ? `${t.label} is queued` : `Run ${t.label}`"
          @click="start(t)"
        >
          {{ queued(t.id) === 'waiting' ? 'Queued' : 'Run' }}
        </v-btn>
      </li>
    </ul>

    <div class="pp__log-head">
      <h3 class="pp__h">Queue</h3>
    </div>
    <p class="pp__queue-help">
      The worker runs one item at a time, oldest first, and reads and scores up to four jobs at once beside it. A restart or deploy pauses it; the items it was on start again when the server is back.
    </p>
    <p v-if="queueEmpty" class="pp__empty">Nothing is waiting.</p>
    <ul v-else class="pp__queue" aria-label="Job queue">
      <li v-for="i in queueDaily" :key="`run-${i.id}`" class="pp__qitem">
        <span class="pp__dot bg-info" />
        <span class="pp__qtext">{{ dailyText(i) }}</span>
        <v-btn v-if="i.cancelable" variant="text" size="small" height="36" :loading="canceling === i.id" @click="cancel(i)">Cancel the rest</v-btn>
      </li>
      <li v-for="i in queueRunning" :key="i.id" class="pp__qitem">
        <span class="pp__dot" :class="`bg-${queueItemColor(i)}`" />
        <span class="pp__qtext pp__qtext--strong">{{ queueItemText(i) }}</span>
      </li>
      <li v-for="b in queueBulk" :key="b.task" class="pp__qitem">
        <span class="pp__dot" :class="b.running ? 'bg-info' : 'bg-secondary'" />
        <span class="pp__qtext" :class="{ 'pp__qtext--strong': b.running > 0 }">{{ bulkText(b) }}</span>
      </li>
      <li v-for="i in queueWaiting" :key="i.id" class="pp__qitem">
        <span class="pp__dot" :class="`bg-${queueItemColor(i)}`" />
        <span class="pp__qtext">{{ queueItemText(i) }}</span>
        <v-btn v-if="i.cancelable && !i.parentId" variant="text" size="small" height="36" :loading="canceling === i.id" @click="cancel(i)">Cancel</v-btn>
      </li>
    </ul>
    <ul v-if="queueRecent.length" class="pp__queue pp__queue--recent" aria-label="Interrupted, failed, and resumed items today">
      <li v-for="i in queueRecent" :key="`recent-${i.id}`" class="pp__qitem">
        <span class="pp__dot" :class="`bg-${queueItemColor(i)}`" />
        <span class="pp__qtext" :class="{ 'text-error': i.status === 'interrupted' }">{{ queueItemText(i) }}</span>
      </li>
    </ul>

    <div class="pp__log-head">
      <h3 class="pp__h">Recent runs</h3>
      <v-btn variant="text" height="44" prepend-icon="mdi-refresh" :loading="health.loading.value" @click="health.refresh(30)">Refresh</v-btn>
    </div>
    <p v-if="health.error.value" class="pp__err" role="alert">{{ health.error.value }}</p>
    <p v-if="heartbeat" class="pp__heartbeat">
      <span class="pp__dot" :class="`bg-${color(heartbeat)}`" />
      {{ taskLabel(heartbeat.task) }}: last at {{ clockTime(heartbeat.startedAt) }}{{ heartbeat.host ? ` on host ${heartbeat.host}` : '' }}. It runs every 15 minutes to show the scheduler is alive.
    </p>
    <p v-if="!runs.length" class="pp__empty">No runs recorded yet.</p>
    <ul v-else class="pp__runs">
      <li v-for="r in runs" :key="r.id" class="pp__run">
        <button type="button" class="pp__run-row" :aria-expanded="openRun === r.id" @click="openRun = openRun === r.id ? null : r.id">
          <span class="pp__dot" :class="`bg-${color(r)}`" />
          <span class="pp__run-task">{{ taskLabel(r.task) }}</span>
          <span class="pp__run-status" :class="`text-${color(r)}`" :title="outcomeText(r)">{{ outcomeText(r) }}</span>
          <span class="pp__run-when">{{ clockTime(r.startedAt) }}</span>
          <span class="pp__run-dur tabular">{{ duration(r) }}</span>
          <v-icon :icon="openRun === r.id ? 'mdi-chevron-up' : 'mdi-chevron-down'" size="18" class="pp__run-chev" />
        </button>
        <v-expand-transition>
          <div v-show="openRun === r.id" class="pp__run-detail">
            <div>Started by {{ TRIGGER[r.trigger] ?? r.trigger }}{{ r.host ? ` on host ${r.host}` : '' }}.</div>
            <ul v-if="(r.problems?.length ?? 0) > 1" class="pp__problems">
              <li v-for="p in r.problems" :key="p" class="text-warning">{{ p }}</li>
            </ul>
            <div v-if="statsText(r.stats)">Result: {{ statsText(r.stats) }}</div>
            <div v-if="runDemos(r.stats).length">
              {{ runDemos(r.stats).length === 1 ? 'Demo' : 'Demos' }}:
              <template v-for="(d, i) in runDemos(r.stats)" :key="d.id">
                <NuxtLink :to="`/demos/${d.id}`" class="pp__demo-link">{{ d.name }}</NuxtLink>{{ d.state ? ` (${d.state})` : '' }}{{ i < runDemos(r.stats).length - 1 ? ', ' : '' }}
              </template>
            </div>
            <div v-if="typeof r.stats?.note === 'string'">{{ r.stats.note }}</div>
            <div v-if="r.error" class="pp__run-error">{{ plainError(r.error) }}</div>
          </div>
        </v-expand-transition>
      </li>
    </ul>
  </div>
</template>

<style scoped lang="scss">
.pp {
  &__budget {
    margin-bottom: 16px;
  }

  &__budget-text {
    font-size: 0.875rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__strong {
    font-weight: 700;
    color: rgb(var(--v-theme-on-surface));
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
  }

  &__stages {
    margin: 0 0 18px;
    padding: 10px 14px;
    border-radius: 8px;
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    font-size: 0.8125rem;
  }

  &__stages-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 88px 168px;
    gap: 12px;
    padding: 3px 0;

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
    margin-top: 8px;
    font-weight: 600;
  }

  &__stages-note {
    margin: 2px 0 0 12px;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__tasks {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  &__task {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 12px 0;
    border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));

    &--main {
      border-top: 0;
      padding: 14px 16px;
      margin-bottom: 4px;
      border-radius: 8px;
      background: rgba(var(--v-theme-primary), 0.07);
      border: 1px solid rgba(var(--v-theme-primary), 0.2);
    }
  }

  &__task-text {
    flex: 1;
    min-width: 0;
  }

  &__task-name {
    font-weight: 600;
    font-size: 0.9375rem;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px 8px;
  }

  &__ai {
    font-size: 0.75rem;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 4px;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    background: rgba(var(--v-theme-on-surface), 0.07);
  }

  &__task-detail {
    font-size: 0.8125rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__task-last {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 2px;
    font-size: 0.75rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__dot {
    width: 8px;
    height: 8px;
    border-radius: 2px;
    flex-shrink: 0;
  }

  &__log-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 20px 0 4px;
  }

  &__h {
    font-size: 0.9375rem;
    font-weight: 700;
    margin: 0;
  }

  &__err,
  &__empty {
    font-size: 0.8125rem;
    margin: 4px 0;
  }

  &__err { color: rgb(var(--v-theme-error)); }
  &__empty { color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }

  &__runs {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  &__run {
    border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  }

  &__run-row {
    width: 100%;
    min-height: 44px;
    display: grid;
    grid-template-columns: 8px minmax(0, 1.2fr) minmax(0, 1.3fr) minmax(0, 0.9fr) 56px 18px;
    align-items: center;
    gap: 10px;
    padding: 8px 0;
    text-align: left;
    font-size: 0.8125rem;
    color: inherit;
  }

  &__run-task {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  &__run-status {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  &__heartbeat {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin: 0 0 8px;
    font-size: 0.8125rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));

    .pp__dot {
      transform: translateY(-1px);
    }
  }

  &__problems {
    margin: 4px 0;
    padding-left: 18px;
  }

  &__queue-help {
    margin: 0 0 6px;
    font-size: 0.8125rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__queue {
    list-style: none;
    margin: 0 0 4px;
    padding: 0;

    &--recent {
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px dashed rgba(var(--v-border-color), var(--v-border-opacity));
    }
  }

  &__qitem {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 36px;
    font-size: 0.8125rem;
  }

  &__qtext {
    flex: 1;
    min-width: 0;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    overflow-wrap: anywhere;

    &--strong {
      font-weight: 600;
      color: rgb(var(--v-theme-on-surface));
    }
  }

  &__run-when,
  &__run-dur {
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  &__run-dur {
    text-align: right;
  }

  &__run-chev {
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__run-detail {
    padding: 0 0 12px 18px;
    font-size: 0.8125rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    overflow-wrap: anywhere;
  }

  &__demo-link {
    color: rgb(var(--v-theme-primary));
  }

  &__run-error {
    margin: 6px 0 0;
    padding: 10px 12px;
    border-radius: 6px;
    font-size: 0.75rem;
    line-height: 1.5;
    overflow-wrap: anywhere;
    color: rgb(var(--v-theme-error));
    background: rgb(var(--v-theme-sunken));
  }
}

@media (max-width: 599.98px) {
  .pp__run-row {
    grid-template-columns: 8px minmax(0, 1fr) auto 18px;
    grid-template-areas: 'dot task when chev' '. status dur .';
    row-gap: 2px;

    .pp__dot { grid-area: dot; }
    .pp__run-task { grid-area: task; }
    .pp__run-status { grid-area: status; white-space: normal; }
    .pp__run-when { grid-area: when; text-align: right; }
    .pp__run-dur { grid-area: dur; }
    .pp__run-chev { grid-area: chev; }
  }

  .pp__task {
    align-items: flex-start;
  }
}
</style>

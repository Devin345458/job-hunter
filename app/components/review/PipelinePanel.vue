<script setup lang="ts">
import type { PipelineRunView } from '#shared/types/pipeline'
import { clockTime, parseTime } from '~/composables/review/format'

// Settings > Pipeline: start any step by hand, watch it run, and read the recent run log.
// Every trigger goes through POST /api/pipeline/run, which starts the task in the background.
const health = usePipelineHealth()
const snackbar = useSnackbar()

interface TaskDef { id: string; label: string; detail: string; usesAi: boolean }
const TASKS: TaskDef[] = [
  { id: 'pipeline:daily', label: 'Full daily run', detail: 'Every step below, in order. This is what runs at 6:00 Central.', usesAi: true },
  { id: 'learn:daily', label: 'Learn from decisions', detail: 'Turns approve and reject reasons into scoring rules.', usesAi: false },
  { id: 'jobs:search', label: 'Search listings', detail: 'Pulls new postings from every active search.', usesAi: false },
  { id: 'jobs:enrich', label: 'Read postings', detail: 'Fetches full postings, apply links, pay, and benefits.', usesAi: true },
  { id: 'jobs:match', label: 'Score matches', detail: 'Scores skills and pay against your floor.', usesAi: true },
  { id: 'applications:prepare', label: 'Prepare applications', detail: 'Tailors the resume, writes the letter, fills the form without submitting.', usesAi: true },
  { id: 'demos:build', label: 'Build demo projects', detail: 'Builds and tests demos for gaps. Nothing is published until you approve.', usesAi: true },
]

const runs = computed<PipelineRunView[]>(() => health.runs.value?.runs ?? [])
const spent = computed(() => health.runs.value?.aiSpentToday ?? 0)
const budget = computed(() => health.runs.value?.aiBudget ?? 0)
const spentPct = computed(() => (budget.value > 0 ? Math.min(100, (spent.value / budget.value) * 100) : 0))
const overBudget = computed(() => budget.value > 0 && spent.value >= budget.value)

function latest(task: string) {
  return runs.value.find(r => r.task === task) ?? null
}

const starting = ref<string | null>(null)
const watching = ref(false)

async function start(task: TaskDef) {
  starting.value = task.id
  try {
    await $fetch('/api/pipeline/run', { method: 'POST', body: { task: task.id } })
    snackbar.info(`Started: ${task.label}`)
    await follow()
  }
  catch (e: any) {
    snackbar.notify(`${task.label} did not start: ${e?.data?.statusMessage || e?.message || 'unknown error'}`, 'error', { timeout: -1 })
  }
  finally {
    starting.value = null
  }
}

/** Refresh the run log until nothing is running, fast at first, for up to two minutes. */
async function follow() {
  if (watching.value) return
  watching.value = true
  try {
    const until = Date.now() + 120_000
    await new Promise(r => setTimeout(r, 600))
    await health.refresh()
    while (Date.now() < until && runs.value.some(r => r.status === 'running')) {
      await new Promise(r => setTimeout(r, 2000))
      await health.refresh()
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

const STATUS_COLOR: Record<PipelineRunView['status'], string> = { succeeded: 'success', failed: 'error', running: 'info', skipped: 'secondary' }
const openRun = ref<number | null>(null)

function statsLine(r: PipelineRunView) {
  if (!r.stats) return ''
  return Object.entries(r.stats)
    .filter(([, v]) => typeof v === 'number' || typeof v === 'string')
    .map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`)
    .slice(0, 6)
    .join(', ')
}

onMounted(() => {
  health.refresh(30).then(() => {
    if (runs.value.some(r => r.status === 'running')) follow()
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
              <span class="pp__dot" :class="`bg-${STATUS_COLOR[latest(t.id)!.status]}`" />
              Last {{ latest(t.id)!.status }} {{ clockTime(latest(t.id)!.startedAt) }}
            </template>
            <template v-else>Not run yet</template>
          </div>
        </div>
        <v-btn
          :color="t.id === 'pipeline:daily' ? 'primary' : undefined"
          :variant="t.id === 'pipeline:daily' ? 'flat' : 'tonal'"
          height="44"
          min-width="96"
          :prepend-icon="latest(t.id)?.status === 'running' ? undefined : 'mdi-play'"
          :loading="starting === t.id || latest(t.id)?.status === 'running'"
          :disabled="starting !== null"
          :aria-label="`Run ${t.label}`"
          @click="start(t)"
        >
          Run
        </v-btn>
      </li>
    </ul>

    <div class="pp__log-head">
      <h3 class="pp__h">Recent runs</h3>
      <v-btn variant="text" height="44" prepend-icon="mdi-refresh" :loading="health.loading.value" @click="health.refresh(30)">Refresh</v-btn>
    </div>
    <p v-if="health.error.value" class="pp__err" role="alert">{{ health.error.value }}</p>
    <p v-if="!runs.length" class="pp__empty">No runs recorded yet.</p>
    <ul v-else class="pp__runs">
      <li v-for="r in runs" :key="r.id" class="pp__run">
        <button type="button" class="pp__run-row" :aria-expanded="openRun === r.id" @click="openRun = openRun === r.id ? null : r.id">
          <span class="pp__dot" :class="`bg-${STATUS_COLOR[r.status]}`" />
          <span class="pp__run-task">{{ TASKS.find(t => t.id === r.task)?.label ?? r.task }}</span>
          <span class="pp__run-status" :class="`text-${STATUS_COLOR[r.status]}`">{{ r.status }}</span>
          <span class="pp__run-when">{{ clockTime(r.startedAt) }}</span>
          <span class="pp__run-dur tabular">{{ duration(r) }}</span>
          <v-icon :icon="openRun === r.id ? 'mdi-chevron-up' : 'mdi-chevron-down'" size="18" class="pp__run-chev" />
        </button>
        <v-expand-transition>
          <div v-show="openRun === r.id" class="pp__run-detail">
            <div>Task {{ r.task }}, started by {{ r.trigger }}{{ r.host ? ` on host ${r.host}` : '' }}.</div>
            <div v-if="statsLine(r)">Result: {{ statsLine(r) }}</div>
            <pre v-if="r.error" class="pp__run-error">{{ r.error }}</pre>
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
    font-size: 0.6875rem;
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
    grid-template-columns: 8px minmax(0, 1.4fr) 84px minmax(0, 1fr) 56px 18px;
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

  &__run-error {
    margin: 6px 0 0;
    padding: 10px 12px;
    border-radius: 6px;
    font-size: 0.75rem;
    line-height: 1.5;
    white-space: pre-wrap;
    color: rgb(var(--v-theme-error));
    background: rgb(var(--v-theme-sunken));
  }
}

@media (max-width: 599.98px) {
  .pp__run-row {
    grid-template-columns: 8px minmax(0, 1fr) auto 18px;
    grid-template-areas: 'dot task status chev' '. when dur .';
    row-gap: 2px;

    .pp__dot { grid-area: dot; }
    .pp__run-task { grid-area: task; }
    .pp__run-status { grid-area: status; }
    .pp__run-when { grid-area: when; }
    .pp__run-dur { grid-area: dur; }
    .pp__run-chev { grid-area: chev; }
  }

  .pp__task {
    align-items: flex-start;
  }
}
</style>

<script setup lang="ts">
import type { SourcesStatus, SourceStatusRow } from '#shared/types/sources'
import { plainError } from '#shared/utils/plain-text'

// Settings > Job sources: one line per source with its last pull time (the watermark after which
// only newer listings are asked for) and what the last search found, passed the filters, already
// knew, and stored. "Pull everything again" clears the watermarks so the next search reads each
// source's whole window: the last 14 days, or every open posting on an employer board.

const snackbar = useSnackbar()
const status = ref<SourcesStatus | null>(null)
const error = ref<string | null>(null)
const resetting = ref(false)

async function load() {
  try {
    status.value = await $fetch<SourcesStatus>('/api/sources')
    error.value = null
  }
  catch (e: any) {
    error.value = e?.data?.statusMessage || 'Could not read the job sources.'
  }
}

async function pullEverything() {
  resetting.value = true
  try {
    await $fetch('/api/sources/reset', { method: 'POST', body: {} })
    snackbar.info('The next search reads every source again: the last 14 days from each job site, every open posting from the employer boards.')
    await load()
  }
  catch (e: any) {
    snackbar.notify(`Nothing changed: ${e?.data?.statusMessage || e?.message || 'unknown error'}`, 'error', { timeout: -1 })
  }
  finally {
    resetting.value = false
  }
}

function when(iso: string | null | undefined): string {
  if (!iso) return ''
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return ''
  const time = t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (t.toDateString() === new Date().toDateString()) return `today at ${time}`
  return `${t.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${time}`
}

const n = (v: number | undefined) => (v ?? 0).toLocaleString('en-US')

const STATUS: Record<string, { text: string; color: string }> = {
  ok: { text: 'Working', color: 'success' },
  partial: { text: 'Partly failed', color: 'warning' },
  failed: { text: 'Failed', color: 'error' },
  unavailable: { text: 'Unavailable', color: 'default' },
  waiting: { text: 'Waiting', color: 'default' },
}

/** A board type with no boards yet (the newer systems fill only through apply links). */
const noBoards = (row: SourceStatusRow) => !!row.boards && !row.boards.curated && !row.boards.discovered

function chip(row: SourceStatusRow) {
  if (!row.selected) return { text: 'Off in your search', color: 'default' }
  if (noBoards(row)) return { text: 'No boards yet', color: 'default' }
  if (!row.lastRun) return { text: 'Not run yet', color: 'default' }
  if (row.lastRun.status === 'waiting' && row.lastRun.overdue) return { text: 'Stuck', color: 'warning' }
  return STATUS[row.lastRun.status] ?? { text: row.lastRun.status, color: 'default' }
}

function pulledLine(row: SourceStatusRow): string {
  if (!row.lastPulledAt) {
    return row.kind === 'board'
      ? 'Not pulled yet. The next search reads every open posting.'
      : 'Not pulled yet. The next search reads the last 14 days.'
  }
  const pending = row.scopesPending ? ` ${row.scopesPending} of ${row.scopes} ${row.kind === 'board' ? 'boards' : 'parts'} still wait for a first full pull.` : ''
  const spread = row.oldestPulledAt && row.oldestPulledAt !== row.lastPulledAt && !row.scopesPending ? ` (oldest ${when(row.oldestPulledAt)})` : ''
  return `Last pulled ${when(row.lastPulledAt)}${spread}.${pending}`
}

function runLine(row: SourceStatusRow): string {
  const r = row.lastRun
  if (!r) return ''
  if (r.status === 'waiting') {
    return r.overdue
      ? `Last search skipped it while it waits between allowed pulls, but it has had no good pull for over twice that interval. Next try after ${when(r.waitUntil ?? row.waitUntil)}.`
      : `Last search skipped it: this source asks not to be called that often. Next pull after ${when(r.waitUntil ?? row.waitUntil)}.`
  }
  if (r.status === 'unavailable' || (r.status === 'failed' && !r.found)) return r.error ? `Last search: ${plainError(r.error)}` : 'Last search: no listings.'
  if (r.passed == null) return `Last search: ${n(r.found)} listings passed the filters, ${n(r.new)} new.`
  const mode = r.mode === 'incremental' ? 'only listings since the last pull' : r.mode === 'mixed' ? 'partly a full pull' : 'a full pull'
  const dupes = r.duplicates ? ` (${n(r.duplicates)} already on another source, not read)` : ''
  return `Last search, ${mode}: ${n(r.found)} found, ${n(r.passed)} passed your filters, ${n(r.known)} already known, ${n(r.new)} new${dupes}, ${n(r.queued ?? r.new)} queued for reading. ${n(r.requests)} ${r.requests === 1 ? 'request' : 'requests'}.`
}

function boardLine(row: SourceStatusRow): string {
  const b = row.boards
  if (!b) return ''
  const total = b.curated + b.discovered
  if (!total) return 'No boards yet. Boards are added when a listing\'s apply link points at one.'
  const parts = [b.curated ? `${b.curated} from the curated list` : '', b.discovered ? `${b.discovered} found through apply links` : ''].filter(Boolean)
  return `${total} ${total === 1 ? 'board' : 'boards'}: ${parts.join(', ')}${b.gone ? `. ${b.gone} found earlier no longer answer` : ''}.`
}

const rows = computed(() => {
  const list = status.value?.rows ?? []
  const rank = (r: SourceStatusRow) => (r.kind === 'aggregator' && r.selected ? 0 : r.kind === 'board' ? 1 : 2)
  return [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
})

onMounted(load)
defineExpose({ load })
</script>

<template>
  <v-card variant="outlined">
    <v-card-item class="job-sources__head">
      <template #prepend>
        <v-avatar color="info" variant="tonal" size="36" rounded="lg">
          <v-icon icon="mdi-database-arrow-down-outline" size="20" />
        </v-avatar>
      </template>
      <v-card-title class="text-subtitle-1 font-weight-medium">
        Job sources
      </v-card-title>
      <v-card-subtitle>
        Each source is read in full the first time (the last 14 days, or every open posting on an employer board), then only for listings added since its last pull.
      </v-card-subtitle>
      <template #append>
        <v-btn
          variant="tonal"
          color="primary"
          height="44"
          prepend-icon="mdi-restore"
          class="job-sources__reset"
          :loading="resetting"
          @click="pullEverything"
        >
          Pull everything again
        </v-btn>
      </template>
    </v-card-item>
    <v-card-text>
      <p v-if="error" class="text-body-2 text-error mb-0" role="alert">{{ error }}</p>
      <template v-else-if="status">
        <p class="job-sources__meta">
          {{ status.lastRunAt ? `Last search ${when(status.lastRunAt.includes('T') ? status.lastRunAt : `${status.lastRunAt.replace(' ', 'T')}Z`)}.` : 'No search has run yet.' }}
        </p>
        <ul class="job-sources__list">
          <li v-for="row in rows" :key="row.source" class="job-sources__row" :class="{ 'job-sources__row--off': !row.selected }">
            <div class="job-sources__name">
              <span class="text-body-2 font-weight-medium">{{ row.name }}</span>
              <v-chip size="x-small" variant="tonal" :color="chip(row).color" label>{{ chip(row).text }}</v-chip>
            </div>
            <div class="job-sources__detail">
              <p v-if="row.selected && !noBoards(row)" class="job-sources__line">{{ pulledLine(row) }}</p>
              <p v-if="row.selected && !noBoards(row) && runLine(row)" class="job-sources__line">{{ runLine(row) }}</p>
              <p v-if="row.boards" class="job-sources__line">{{ boardLine(row) }}</p>
              <p v-if="!row.selected" class="job-sources__line">Not in an active search configuration. Tick it in Search Configurations to pull it.</p>
            </div>
          </li>
        </ul>
      </template>
    </v-card-text>
  </v-card>
</template>

<style scoped lang="scss">
.job-sources {
  &__reset {
    text-transform: none;
    letter-spacing: normal;
  }

  &__meta {
    margin: 0 0 8px;
    font-size: 0.875rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  &__row {
    display: grid;
    grid-template-columns: 220px minmax(0, 1fr);
    gap: 4px 16px;
    padding: 10px 0;
    border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));

    &:first-child {
      border-top: 0;
    }

    &--off .job-sources__name span {
      color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    }
  }

  &__name {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
    min-width: 0;
  }

  &__detail {
    min-width: 0;
  }

  &__line {
    margin: 0;
    font-size: 0.8125rem;
    line-height: 1.5;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    text-wrap: pretty;

    & + & {
      margin-top: 2px;
    }
  }
}

@media (max-width: 599.98px) {
  .job-sources__row {
    grid-template-columns: minmax(0, 1fr);
  }

  .job-sources__head {
    grid-template-areas:
      'prepend content'
      '. append';

    :deep(.v-card-item__append) {
      justify-self: start;
      padding-inline-start: 0;
      padding-top: 12px;
    }
  }
}
</style>

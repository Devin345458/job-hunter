<script setup lang="ts">
import type { JobStatus, RemoteType } from '~/composables/useJobs'

export interface JobFilterValues {
  search: string
  status: JobStatus[]
  remoteType: RemoteType | null
  minScore: number
  maxScore: number
}

const props = defineProps<{
  /** Values to start from, when the jobs page restores a list Devin left for a job. */
  initial?: JobFilterValues | null
}>()

const emit = defineEmits<{
  'update:filters': [filters: JobFilterValues]
}>()

// New means nothing has happened with the job yet. A job with an application under way files
// under In review, so the filter matches the state its card shows.
const statusOptions: { title: string; value: JobStatus }[] = [
  { title: 'New', value: 'new' },
  { title: 'In review', value: 'in_review' },
  { title: 'Reviewed', value: 'reviewed' },
  { title: 'Applied', value: 'applied' },
  { title: 'Rejected', value: 'rejected' },
  { title: 'Expired', value: 'expired' },
]

const remoteOptions: { title: string; value: RemoteType }[] = [
  { title: 'Remote', value: 'remote' },
  { title: 'Hybrid', value: 'hybrid' },
  { title: 'On-site', value: 'onsite' },
]

const search = ref(props.initial?.search ?? '')
const status = ref<JobStatus[]>([...(props.initial?.status ?? [])])
const remoteType = ref<RemoteType | null>(props.initial?.remoteType ?? null)
const scoreRange = ref<[number, number]>([props.initial?.minScore ?? 0, props.initial?.maxScore ?? 100])

/** Phone only: the filters below the search field fold away so the jobs start near the top. */
const expanded = ref(false)

// A chip's close button is an 18px target the chip clips, so the phone shows the chips without
// it; the field's clear icon (44px) clears them all, and the menu removes one.
const isDesktop = useState<boolean>('shell-is-desktop')

/** Filters other than the search text that differ from their defaults, for the phone toggle. */
const activeCount = computed(() =>
  (status.value.length ? 1 : 0)
  + (remoteType.value ? 1 : 0)
  + (scoreRange.value[0] > 0 || scoreRange.value[1] < 100 ? 1 : 0),
)

const hasAnyFilter = computed(() => activeCount.value > 0 || !!search.value)

// Every change goes through emitFilters, and an unchanged set of filters is never sent twice.
// Clear used to send two identical list requests (its own emit plus the watcher's).
let lastEmitted = JSON.stringify(currentValues())

function currentValues(): JobFilterValues {
  return {
    search: (search.value || '').trim(),
    status: [...status.value],
    remoteType: remoteType.value,
    minScore: scoreRange.value[0],
    maxScore: scoreRange.value[1],
  }
}

function emitFilters() {
  const values = currentValues()
  const key = JSON.stringify(values)
  if (key === lastEmitted) return
  lastEmitted = key
  emit('update:filters', values)
}

let searchTimer: ReturnType<typeof setTimeout> | null = null
let scoreTimer: ReturnType<typeof setTimeout> | null = null

function cancelTimers() {
  if (searchTimer) clearTimeout(searchTimer)
  if (scoreTimer) clearTimeout(scoreTimer)
  searchTimer = scoreTimer = null
}

// Typing and dragging the score slider wait for a pause; the selects apply at once.
watch(search, () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(emitFilters, 350)
})

watch(scoreRange, () => {
  if (scoreTimer) clearTimeout(scoreTimer)
  scoreTimer = setTimeout(emitFilters, 250)
}, { deep: true })

watch([status, remoteType], emitFilters, { deep: true })

function clearFilters() {
  cancelTimers()
  search.value = ''
  status.value = []
  remoteType.value = null
  scoreRange.value = [0, 100]
  emitFilters()
}

onBeforeUnmount(cancelTimers)
</script>

<template>
  <div class="job-filters">
    <div class="job-filters__row">
      <v-text-field
        v-model="search"
        class="job-filters__search"
        placeholder="Search jobs"
        aria-label="Search jobs"
        prepend-inner-icon="mdi-magnify"
        clearable
        hide-details
        @click:clear="search = ''"
      />

      <v-btn
        class="job-filters__toggle"
        variant="outlined"
        height="40"
        :prepend-icon="expanded ? 'mdi-chevron-up' : 'mdi-tune-variant'"
        :aria-expanded="expanded ? 'true' : 'false'"
        aria-controls="job-filters-more"
        @click="expanded = !expanded"
      >
        Filters
        <span v-if="activeCount" class="job-filters__count tabular">{{ activeCount }}</span>
      </v-btn>

      <div id="job-filters-more" class="job-filters__more" :class="{ 'job-filters__more--open': expanded }">
        <v-select
          v-model="status"
          class="job-filters__status"
          :items="statusOptions"
          placeholder="Status"
          aria-label="Status"
          persistent-placeholder
          multiple
          clearable
          hide-details
          chips
          :closable-chips="isDesktop"
        />

        <v-select
          v-model="remoteType"
          class="job-filters__work-type"
          :items="remoteOptions"
          placeholder="Work type"
          aria-label="Work type"
          persistent-placeholder
          clearable
          hide-details
        />

        <div class="job-filters__score">
          <div id="job-filters-score-label" class="job-filters__score-label">
            Match score <span class="tabular">{{ scoreRange[0] }} to {{ scoreRange[1] }}</span>
          </div>
          <v-range-slider
            v-model="scoreRange"
            :min="0"
            :max="100"
            :step="5"
            hide-details
            color="primary"
            aria-labelledby="job-filters-score-label"
          />
        </div>

        <v-btn
          class="job-filters__clear"
          variant="text"
          height="40"
          :disabled="!hasAnyFilter"
          :title="hasAnyFilter ? undefined : 'No filter is set'"
          @click="clearFilters"
        >
          Clear
        </v-btn>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
// A flat toolbar on the page ground: 40px controls in one row (44px on a phone).
.job-filters {

  &__row,
  &__more {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
  }

  // Each control gets the width its label and value need; nothing is squeezed into a 2-column cell.
  &__search {
    flex: 2 1 220px;
    min-width: 0;
  }

  // On desktop the folded group is not a box of its own: its controls sit in the same row as search.
  &__more {
    display: contents;
  }

  &__status {
    flex: 1 1 170px;
    min-width: 0;
  }

  &__work-type {
    flex: 0 0 168px;
  }

  // The label sits above the slider; the pair is as tall as a 40px field.
  &__score {
    flex: 1 1 160px;
    min-width: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
    height: 40px;

    :deep(.v-slider.v-input--horizontal) {
      margin-inline: 8px;
    }

    :deep(.v-input__control) {
      min-height: 24px;
    }
  }

  &__score-label {
    font-size: 0.75rem;
    line-height: 1.2;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    padding-inline: 8px;
  }

  &__clear {
    flex: 0 0 auto;
  }

  &__toggle {
    display: none;
  }

  &__count {
    display: inline-grid;
    place-items: center;
    min-width: 20px;
    height: 20px;
    margin-left: 8px;
    padding: 0 6px;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 600;
    background: rgb(var(--v-theme-primary));
    color: rgb(var(--v-theme-on-primary));
  }

  // Phone shell: search and a Filters toggle on one row; the rest opens below it.
  @media (max-width: 959.98px) {
    &__search {
      flex: 1 1 0;
    }

    &__toggle {
      display: inline-grid;
      flex: 0 0 auto;
    }

    &__more {
      display: none;
      flex: 1 1 100%;
      flex-direction: column;
      align-items: stretch;
    }

    &__more--open {
      display: flex;
    }

    &__status,
    &__work-type,
    &__score,
    &__clear {
      flex: 0 0 auto;
      width: 100%;
    }
  }
}
</style>

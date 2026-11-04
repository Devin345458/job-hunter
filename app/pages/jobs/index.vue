<script setup lang="ts">
import type { JobFilters, JobListItem, JobSort } from '~/composables/useJobs'
import type { JobFilterValues } from '~/components/jobs/JobFilters.vue'
import { SupersededRequest } from '~/composables/useJobs'
import { countText as formatCount } from '#shared/utils/pay-format'

// Coming back from a job page, the router leaves the scroll alone; the page restores it below.
definePageMeta({
  layout: 'default',
  scrollToTop: (_to, from) => !/^\/jobs\/\d+/.test(from.path),
})

/** Divides evenly into the two and three column grids. */
const PAGE_SIZE = 24

const router = useRouter()
const { jobs, total, totalPostings, page, loading, error, fetchJobs, triggerSearch } = useJobs()
const snackbar = useSnackbar()

// ── Back to Jobs keeps the list ──
// Opening a job saves the list as it stands: sort, filters, every loaded page, and the scroll
// position. Coming back from that job (Back to Jobs, or the browser's back button) restores it
// instead of starting over on the first page. Any other way in starts fresh.
interface JobsListSnapshot {
  filters: JobFilters
  filterValues: JobFilterValues | null
  sort: JobSort
  jobs: JobListItem[]
  total: number
  totalPostings: number
  page: number
  scrollY: number
}
const JOB_PAGE = /^\/jobs\/\d+/
const snapshot = useState<JobsListSnapshot | null>('jobs-list-snapshot', () => null)
const historyState = (import.meta.client ? router.options.history.state : {}) as Record<string, unknown>
const backFromJob = [historyState.back, historyState.forward].some(p => typeof p === 'string' && JOB_PAGE.test(p))
const restored = backFromJob ? snapshot.value : null

const filters = ref<JobFilters>(restored?.filters ?? {})
/** The filter controls' own values, handed back to them when the list is restored. */
const filterValues = ref<JobFilterValues | null>(restored?.filterValues ?? null)
/** Best match first by default, so strong matches lead instead of whatever was found last. */
const sort = ref<JobSort>(restored?.sort ?? 'score')
if (restored) {
  jobs.value = restored.jobs
  total.value = restored.total
  totalPostings.value = restored.totalPostings ?? restored.total
  page.value = restored.page
}
const loadingMore = ref(false)
const hasMore = computed(() => jobs.value.length < total.value)
/** The page's one line about the data: "1,835 jobs, from 2,081 postings". */
const dataLine = computed(() => {
  if (!total.value && !jobs.value.length) return ''
  const jobsText = `${formatCount(total.value)} job${total.value !== 1 ? 's' : ''}`
  return totalPostings.value > total.value ? `${jobsText}, from ${formatCount(totalPostings.value)} postings` : jobsText
})
/** Under the list: how far it has loaded. */
const shownText = computed(() => `Showing ${formatCount(jobs.value.length)} of ${formatCount(total.value)}`)

async function load(options: { append?: boolean } = {}) {
  try {
    await fetchJobs({
      ...filters.value,
      sort: sort.value,
      page: options.append ? page.value + 1 : 1,
      limit: PAGE_SIZE,
    }, options)
  }
  catch (e) {
    // A newer request replaced this one, or the error is already in `error` and shown above the list.
    if (!(e instanceof SupersededRequest)) console.error('[jobs] list request failed', e)
  }
}

function onFiltersUpdate(values: JobFilterValues) {
  filterValues.value = values
  filters.value = {
    search: values.search || undefined,
    status: values.status.length ? values.status : undefined,
    remoteType: values.remoteType || undefined,
    minScore: values.minScore > 0 ? values.minScore : undefined,
    maxScore: values.maxScore < 100 ? values.maxScore : undefined,
  }
  load()
}

watch(sort, () => load())

async function loadMore() {
  loadingMore.value = true
  try {
    await load({ append: true })
  }
  finally {
    loadingMore.value = false
  }
}

// ── Search now ───────────────────────────────────────────────
const confirmSearch = ref(false)
const searching = ref(false)

async function runSearch() {
  confirmSearch.value = false
  searching.value = true
  try {
    const result = await triggerSearch()
    if (result.queued) {
      snackbar.info(result.message, { text: 'View queue', handler: () => router.push('/settings/pipeline#queue') })
      return
    }
    // New postings are read and scored afterward, one queue item each, so under Best match they would sit at
    // the end. Show them first.
    if (result.jobsFound > 0 && sort.value !== 'date') sort.value = 'date'
    else await load()
    const found = `${result.found} listing${result.found === 1 ? '' : 's'} checked`
    const settingsAction = { text: 'View run', handler: () => router.push('/settings/pipeline#runs') }
    if (result.jobsFound > 0) {
      snackbar.success(`Search finished: ${result.jobsFound} new job${result.jobsFound === 1 ? '' : 's'}, shown first under Newest. ${found}.`, settingsAction)
    }
    else {
      snackbar.info(`Search finished: no new jobs, ${found}.`, settingsAction)
    }
  }
  catch (e: any) {
    const message = e?.data?.statusMessage || e?.statusMessage || e?.message || 'The job search failed.'
    snackbar.error(message, {
      text: 'Job search settings',
      handler: () => router.push('/settings/job-search'),
    })
  }
  finally {
    searching.value = false
  }
}

onMounted(() => {
  if (restored) {
    nextTick(() => requestAnimationFrame(() => window.scrollTo({ top: restored.scrollY })))
    return
  }
  // From a job page with nothing saved (it was opened from Learning, say), start at the top.
  if (backFromJob) window.scrollTo({ top: 0 })
  load()
})

onBeforeRouteLeave((to) => {
  if (!JOB_PAGE.test(to.path)) return
  snapshot.value = {
    filters: { ...filters.value },
    filterValues: filterValues.value,
    sort: sort.value,
    jobs: jobs.value,
    total: total.value,
    totalPostings: totalPostings.value,
    page: page.value,
    scrollY: window.scrollY,
  }
})
</script>

<template>
  <div class="jobs-page fade-in">
    <div class="page-header page-header--split">
      <div>
        <h1 class="text-h4 page-header__title">Jobs</h1>
        <p class="page-header__subtitle" aria-live="polite">{{ dataLine || '\u00a0' }}</p>
      </div>
      <v-btn
        color="primary"
        prepend-icon="mdi-magnify"
        :loading="searching"
        @click="confirmSearch = true"
      >
        Search now
      </v-btn>
    </div>

    <div class="jobs-page__toolbar">
      <JobsJobFilters :initial="filterValues" class="jobs-page__filters" @update:filters="onFiltersUpdate" />
      <v-btn-toggle
        v-model="sort"
        mandatory
        density="compact"
        variant="outlined"
        divided
        class="jobs-page__sort"
        aria-label="Sort jobs"
      >
        <v-btn value="score">
          Best match
        </v-btn>
        <v-btn value="date">
          Newest
        </v-btn>
      </v-btn-toggle>
    </div>

    <v-alert
      v-if="error"
      type="error"
      variant="tonal"
      closable
      class="mb-4"
    >
      <v-alert-title class="text-body-2 font-weight-bold">Something went wrong</v-alert-title>
      <div class="text-body-2 mt-1">{{ error }}</div>
      <div class="mt-3">
        <v-btn
          variant="outlined"
          size="small"
          color="error"
          prepend-icon="mdi-refresh"
          @click="load()"
        >
          Try Again
        </v-btn>
      </div>
    </v-alert>

    <v-progress-linear
      v-if="loading && !loadingMore"
      indeterminate
      color="primary"
      height="2"
      class="jobs-page__progress"
      aria-label="Loading jobs"
    />

    <template v-if="jobs.length">
      <!-- The column header shares the rows' grid, so each figure ends on one right edge. -->
      <div class="jobs-page__head" aria-hidden="true">
        <span class="jobs-page__h-num">Score</span>
        <span>Role</span>
        <span>State</span>
        <span class="jobs-page__h-num">Base pay</span>
        <span class="jobs-page__h-num">Total pay</span>
      </div>
      <ul class="jobs-page__list" aria-label="Jobs">
        <li v-for="job in jobs" :key="job.id">
          <JobsJobRow :job="job" />
        </li>
      </ul>

      <div class="jobs-page__more">
        <span class="jobs-page__shown">{{ shownText }}</span>
        <v-btn
          v-if="hasMore"
          variant="outlined"
          :loading="loadingMore"
          :disabled="loading && !loadingMore"
          @click="loadMore"
        >
          Load {{ Math.min(PAGE_SIZE, total - jobs.length) }} more
        </v-btn>
      </div>
    </template>

    <v-card
      v-else-if="!loading"
      variant="outlined"
      class="text-center pa-10"
    >
      <h2 class="text-h6 mb-2">No jobs match</h2>
      <p class="text-body-2 text-medium-emphasis mb-2" style="max-width: 420px; margin: 0 auto;">
        Clear a filter, or set what to search for in Settings > Job search.
      </p>
      <div class="d-flex flex-wrap justify-center ga-3 mt-4">
        <v-btn
          variant="outlined"
          to="/settings/job-search"
        >
          Job search settings
        </v-btn>
        <v-btn
          variant="outlined"
          prepend-icon="mdi-magnify"
          :loading="searching"
          @click="confirmSearch = true"
        >
          Search now
        </v-btn>
      </div>
    </v-card>

    <!-- One click used to start a live search with no warning. -->
    <v-dialog v-model="confirmSearch" max-width="460">
      <v-card>
        <v-card-title class="text-h6 pt-5 px-6">
          Search for new jobs now?
        </v-card-title>
        <v-card-text class="px-6">
          <p class="text-body-2 mb-3">
            This runs every active search configuration against the job boards right away, instead of waiting for the next scheduled run. It can take a minute.
          </p>
          <p class="text-body-2 text-medium-emphasis mb-0">
            New postings are listed first under Newest until the next scheduled run scores them. The run is logged in Settings > Pipeline under Recent runs.
          </p>
        </v-card-text>
        <v-card-actions class="px-6 pb-5">
          <v-spacer />
          <v-btn variant="text" @click="confirmSearch = false">
            Cancel
          </v-btn>
          <v-btn color="primary" variant="flat" prepend-icon="mdi-magnify" @click="runSearch">
            Search now
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped lang="scss">
.jobs-page {
  // One row of controls: the filters, then the sort at the right end.
  &__toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin-bottom: 16px;
  }

  &__filters {
    flex: 1 1 0;
    min-width: 0;

    // Phone: search and Filters get the whole row; the sort sits on the row under them.
    @media (max-width: 959.98px) {
      flex-basis: 100%;
    }
  }

  &__sort {
    flex: 0 0 auto;
    height: 40px !important;

    .v-btn {
      font-size: 0.8125rem;
    }
  }

  &__progress {
    margin-bottom: 4px;
  }

  // Same columns as JobRow: score 48 | role | state 148 | base 156 | total 156.
  &__head {
    display: grid;
    grid-template-columns: 48px minmax(0, 1fr) 148px 156px 156px;
    column-gap: 16px;
    padding: 0 12px 8px;
    font-size: 0.75rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    margin-bottom: 4px;

    @media (max-width: 1099.98px) {
      grid-template-columns: 40px minmax(0, 1fr) 140px 140px;

      > :nth-child(3) {
        display: none;
      }
    }

    @media (max-width: 639.98px) {
      display: none;
    }
  }

  &__h-num {
    text-align: right;
  }

  &__list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  &__more {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: 16px;
    padding: 0 12px;
  }

  &__shown {
    font-size: 0.8125rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }
}
</style>

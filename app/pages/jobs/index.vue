<script setup lang="ts">
import type { JobFilters, JobListItem, JobSort } from '~/composables/useJobs'
import type { JobFilterValues } from '~/components/jobs/JobFilters.vue'
import { SupersededRequest } from '~/composables/useJobs'

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
/** "Showing 24 of 378 jobs, from 405 postings." when some cards stand for several postings of one role. */
const countText = computed(() => {
  const shown = `Showing ${jobs.value.length} of ${total.value} job${total.value !== 1 ? 's' : ''}`
  return totalPostings.value > total.value
    ? `${shown}, from ${totalPostings.value} postings. A role posted more than once shows as one card.`
    : shown
})

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
        <h1 class="text-h4 page-header__title">Job Feed</h1>
        <p class="text-body-2 page-header__subtitle">
          Browse jobs matched to your profile. Use filters to narrow results, or open a job to see match details and generate a tailored resume.
        </p>
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

    <div class="mb-6">
      <JobsJobFilters :initial="filterValues" @update:filters="onFiltersUpdate" />
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

    <div class="jobs-page__status">
      <div class="jobs-page__status-row">
        <!-- Not tabular: under tabular figures the font gives the comma and period a digit-wide slot. -->
        <div class="text-caption text-medium-emphasis" aria-live="polite">
          <template v-if="jobs.length">
            {{ countText }}
          </template>
        </div>
        <v-btn-toggle
          v-model="sort"
          mandatory
          density="compact"
          variant="outlined"
          divided
          class="jobs-page__sort"
          aria-label="Sort jobs"
        >
          <v-btn value="score" prepend-icon="mdi-sort-numeric-descending">
            Best match
          </v-btn>
          <v-btn value="date" prepend-icon="mdi-clock-outline">
            Newest
          </v-btn>
        </v-btn-toggle>
      </div>
      <v-progress-linear
        v-if="loading && !loadingMore"
        indeterminate
        color="primary"
        class="jobs-page__progress"
        aria-label="Loading jobs"
      />
    </div>

    <template v-if="jobs.length">
      <v-row class="stagger-in">
        <v-col
          v-for="job in jobs"
          :key="job.id"
          cols="12"
          sm="6"
          lg="4"
        >
          <JobsJobCard :job="job" />
        </v-col>
      </v-row>

      <div v-if="hasMore" class="jobs-page__more">
        <v-btn
          variant="outlined"
          prepend-icon="mdi-chevron-down"
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
      class="text-center pa-12"
    >
      <v-icon icon="mdi-briefcase-search-outline" size="64" class="mb-4" style="opacity: 0.3;" />
      <h3 class="text-h6 mb-2">No Jobs Found</h3>
      <p class="text-body-2 text-medium-emphasis mb-2" style="max-width: 400px; margin: 0 auto;">
        Jobs appear here after a search runs. Set what to search for in Settings > Job search, then wait for the next scheduled run or start one with Search now.
      </p>
      <div class="d-flex flex-wrap justify-center ga-3 mt-4">
        <v-btn
          variant="tonal"
          color="primary"
          prepend-icon="mdi-tune-variant"
          to="/settings/job-search"
        >
          Configure Search
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
  &__status {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 12px;
  }

  &__status-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 16px;
  }

  &__sort {
    flex: 0 0 auto;

    .v-btn {
      font-size: 0.8125rem;
    }
  }

  &__more {
    display: flex;
    justify-content: center;
    margin-top: 24px;
  }
}
</style>

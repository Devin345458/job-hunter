<script setup lang="ts">
import type { JobFilters, JobSort } from '~/composables/useJobs'
import type { JobFilterValues } from '~/components/jobs/JobFilters.vue'
import { SupersededRequest } from '~/composables/useJobs'

definePageMeta({
  layout: 'default',
})

/** Divides evenly into the two and three column grids. */
const PAGE_SIZE = 24

const router = useRouter()
const { jobs, total, page, loading, error, fetchJobs, triggerSearch } = useJobs()
const snackbar = useSnackbar()

const filters = ref<JobFilters>({})
/** Best match first by default, so strong matches lead instead of whatever was found last. */
const sort = ref<JobSort>('score')
const loadingMore = ref(false)
const hasMore = computed(() => jobs.value.length < total.value)

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
    // New postings are not scored until the daily run, so under Best match they would sit at
    // the end. Show them first.
    if (result.jobsFound > 0 && sort.value !== 'date') sort.value = 'date'
    else await load()
    const found = `${result.found} listing${result.found === 1 ? '' : 's'} checked`
    const settingsAction = { text: 'View run', handler: () => router.push('/settings') }
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
      text: 'Go to Settings',
      handler: () => router.push('/settings'),
    })
  }
  finally {
    searching.value = false
  }
}

onMounted(() => {
  load()
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
      <JobsJobFilters @update:filters="onFiltersUpdate" />
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
        <div class="text-caption text-medium-emphasis tabular" aria-live="polite">
          <template v-if="jobs.length">
            Showing {{ jobs.length }} of {{ total }} job{{ total !== 1 ? 's' : '' }}
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
        Jobs appear here after a search runs. Set what to search for in Settings, then wait for the daily run or start one with Search now.
      </p>
      <div class="d-flex flex-wrap justify-center ga-3 mt-4">
        <v-btn
          variant="tonal"
          color="primary"
          prepend-icon="mdi-tune-variant"
          to="/settings"
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
            This runs every active search configuration against the job boards right away, instead of waiting for the 6:00 daily run. It can take a minute.
          </p>
          <p class="text-body-2 text-medium-emphasis mb-0">
            New postings are listed first under Newest until the daily run scores them. The run is logged in Settings under Recent runs.
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

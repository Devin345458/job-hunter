<script setup lang="ts">
import type { JobStatus, RemoteType } from '~/composables/useJobs'

interface JobFilterValues {
  search: string
  status: JobStatus[]
  remoteType: RemoteType | null
  minScore: number
  maxScore: number
}

definePageMeta({
  layout: 'default',
})

const router = useRouter()
const { jobs, loading, error, fetchJobs, triggerSearch } = useJobs()
const snackbar = useSnackbar()

const searching = ref(false)

async function onFiltersUpdate(filters: JobFilterValues) {
  await fetchJobs({
    search: filters.search || undefined,
    status: filters.status.length ? filters.status : undefined,
    remoteType: filters.remoteType || undefined,
    minScore: filters.minScore > 0 ? filters.minScore : undefined,
  })
}

async function onTriggerSearch() {
  searching.value = true
  try {
    const result = await triggerSearch()
    await fetchJobs()
    if (result.jobsFound > 0) {
      snackbar.success(`Found ${result.jobsFound} new jobs`)
    }
    else {
      snackbar.info('Search complete. No new jobs found matching your criteria.')
    }
  }
  catch {
    snackbar.error('Search failed. Check your API keys in Settings.', {
      text: 'Go to Settings',
      handler: () => router.push('/settings'),
    })
  }
  finally {
    searching.value = false
  }
}

function onJobClick(job: { id: number }) {
  router.push(`/jobs/${job.id}`)
}

onMounted(() => {
  fetchJobs()
})
</script>

<template>
  <div class="fade-in">
    <!-- Page Header -->
    <div class="page-header mb-8">
      <h1 class="text-h4 page-header__title">Job Feed</h1>
      <p class="text-body-2 page-header__subtitle">
        Browse jobs matched to your profile. Use filters to narrow results, or click a job to see match details and generate a tailored resume.
      </p>
    </div>

    <!-- Filter Bar -->
    <div class="mb-6">
      <JobsJobFilters @update:filters="onFiltersUpdate" />
    </div>

    <!-- Error Alert -->
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
          @click="fetchJobs()"
        >
          Try Again
        </v-btn>
      </div>
    </v-alert>

    <!-- Loading -->
    <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-4" />

    <!-- Job Grid -->
    <template v-if="jobs.length">
      <div class="text-caption text-medium-emphasis mb-3">
        {{ jobs.length }} job{{ jobs.length !== 1 ? 's' : '' }} found
      </div>
      <v-row class="stagger-in">
        <v-col
          v-for="job in jobs"
          :key="job.id"
          cols="12"
          sm="6"
          lg="4"
        >
          <JobsJobCard :job="job" @click="onJobClick" />
        </v-col>
      </v-row>
    </template>

    <!-- Empty State -->
    <v-card
      v-else-if="!loading"
      variant="outlined"
      class="text-center pa-12"
    >
      <v-icon icon="mdi-briefcase-search-outline" size="64" class="mb-4" style="opacity: 0.3;" />
      <h3 class="text-h6 mb-2">No Jobs Found</h3>
      <p class="text-body-2 text-medium-emphasis mb-2" style="max-width: 400px; margin: 0 auto;">
        Jobs appear here after running a search. You can configure your search criteria in Settings, then either wait for the daily automated search or trigger one manually.
      </p>
      <div class="d-flex justify-center ga-3 mt-4">
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
          @click="onTriggerSearch"
        >
          Run Search Now
        </v-btn>
      </div>
    </v-card>

    <!-- FAB: Trigger Search -->
    <v-btn
      v-if="jobs.length"
      icon
      color="primary"
      size="large"
      position="fixed"
      location="bottom end"
      class="ma-6"
      :loading="searching"
      @click="onTriggerSearch"
    >
      <v-icon icon="mdi-magnify" />
      <v-tooltip activator="parent" location="start">
        Run Manual Search
      </v-tooltip>
    </v-btn>
  </div>
</template>

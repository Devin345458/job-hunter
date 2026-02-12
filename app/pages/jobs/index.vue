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
      // Could show a snackbar notification here
    }
  }
  catch {
    // Error handled by composable
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
  <div>
    <div class="d-flex align-center justify-space-between mb-6">
      <h1 class="text-h4 font-weight-bold">Job Feed</h1>
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
      {{ error }}
    </v-alert>

    <!-- Loading -->
    <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-4" />

    <!-- Job Grid -->
    <template v-if="jobs.length">
      <v-row>
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
      <v-icon icon="mdi-briefcase-search-outline" size="80" color="secondary" class="mb-4" />
      <h3 class="text-h6 mb-2">No Jobs Found</h3>
      <p class="text-body-2 text-medium-emphasis mb-4">
        Configure your search settings and run a search to discover matching jobs.
      </p>
      <v-btn
        variant="tonal"
        color="primary"
        prepend-icon="mdi-cog"
        to="/settings"
      >
        Configure Search
      </v-btn>
    </v-card>

    <!-- FAB: Trigger Search -->
    <v-btn
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

<script setup lang="ts">
import type { ApplicationStatus, ApplicationWithJob } from '~/composables/useApplications'

definePageMeta({
  layout: 'default',
})

const router = useRouter()
const { applications, loading, error, fetchApplications } = useApplications()

const searchQuery = ref('')
const activeTab = ref('all')

const statusTabs: { title: string; value: string }[] = [
  { title: 'All', value: 'all' },
  { title: 'Draft', value: 'draft' },
  { title: 'Submitted', value: 'submitted' },
  { title: 'Interviewing', value: 'interviewing' },
  { title: 'Offer', value: 'offer' },
  { title: 'Rejected', value: 'rejected' },
]

const statusColors: Record<ApplicationStatus, string> = {
  draft: 'grey',
  ready: 'info',
  submitted: 'primary',
  response_received: 'accent',
  interviewing: 'warning',
  rejected: 'error',
  offer: 'success',
}

const statusLabels: Record<ApplicationStatus, string> = {
  draft: 'Draft',
  ready: 'Ready',
  submitted: 'Submitted',
  response_received: 'Response',
  interviewing: 'Interviewing',
  rejected: 'Rejected',
  offer: 'Offer',
}

const filteredApplications = computed(() => {
  let filtered = applications.value

  if (activeTab.value !== 'all') {
    filtered = filtered.filter(a => a.status === activeTab.value)
  }

  if (searchQuery.value) {
    const query = searchQuery.value.toLowerCase()
    filtered = filtered.filter(a =>
      a.job?.company?.toLowerCase().includes(query)
      || a.job?.title?.toLowerCase().includes(query),
    )
  }

  return filtered
})

const tableHeaders = [
  { title: 'Company', key: 'company', sortable: true },
  { title: 'Role', key: 'role', sortable: true },
  { title: 'Date Applied', key: 'date', sortable: true },
  { title: 'Status', key: 'status', sortable: true },
  { title: 'Match Score', key: 'score', sortable: true, align: 'center' as const },
]

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '-'
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function navigateToApplication(application: ApplicationWithJob) {
  router.push(`/applications/${application.id}`)
}

async function loadApplications() {
  try {
    await fetchApplications()
  }
  catch {
    // Error handled by composable
  }
}

watch(activeTab, () => {
  const statusFilter = activeTab.value !== 'all' ? activeTab.value as ApplicationStatus : undefined
  fetchApplications({ status: statusFilter })
})

onMounted(() => {
  loadApplications()
})
</script>

<template>
  <div>
    <div class="d-flex align-center justify-space-between mb-6">
      <h1 class="text-h4 font-weight-bold">Applications</h1>
    </div>

    <!-- Search Bar -->
    <v-text-field
      v-model="searchQuery"
      label="Search by company or role"
      prepend-inner-icon="mdi-magnify"
      clearable
      hide-details
      class="mb-4"
    />

    <!-- Status Filter Tabs -->
    <v-tabs
      v-model="activeTab"
      color="primary"
      class="mb-4"
    >
      <v-tab
        v-for="tab in statusTabs"
        :key="tab.value"
        :value="tab.value"
      >
        {{ tab.title }}
      </v-tab>
    </v-tabs>

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

    <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-4" />

    <!-- Applications Table -->
    <v-card v-if="filteredApplications.length" variant="outlined">
      <v-table hover>
        <thead>
          <tr>
            <th
              v-for="header in tableHeaders"
              :key="header.key"
              :class="header.align === 'center' ? 'text-center' : ''"
            >
              {{ header.title }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="app in filteredApplications"
            :key="app.id"
            class="cursor-pointer"
            @click="navigateToApplication(app)"
          >
            <td>{{ app.job?.company || 'Unknown' }}</td>
            <td>{{ app.job?.title || 'Unknown' }}</td>
            <td>{{ formatDate(app.submittedAt || app.createdAt) }}</td>
            <td>
              <v-chip
                :color="statusColors[app.status as ApplicationStatus] || 'grey'"
                size="small"
                variant="tonal"
              >
                {{ statusLabels[app.status as ApplicationStatus] || app.status }}
              </v-chip>
            </td>
            <td class="text-center">
              <JobsMatchScoreBadge
                v-if="app.job?.matchScore != null"
                :score="app.job.matchScore"
                size="small"
              />
              <span v-else class="text-medium-emphasis">-</span>
            </td>
          </tr>
        </tbody>
      </v-table>
    </v-card>

    <!-- Empty State -->
    <v-card
      v-else-if="!loading"
      variant="outlined"
      class="text-center pa-12"
    >
      <v-icon icon="mdi-file-document-outline" size="80" color="secondary" class="mb-4" />
      <h3 class="text-h6 mb-2">No Applications Yet</h3>
      <p class="text-body-2 text-medium-emphasis mb-4">
        Browse jobs and generate tailored resumes to start tracking your applications.
      </p>
      <v-btn
        variant="tonal"
        color="primary"
        prepend-icon="mdi-briefcase-search"
        to="/jobs"
      >
        Browse Jobs
      </v-btn>
    </v-card>
  </div>
</template>

<style scoped lang="scss">
.cursor-pointer {
  cursor: pointer;
}
</style>

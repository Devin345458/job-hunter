<script setup lang="ts">
definePageMeta({ layout: 'default' })

interface PipelineCounts {
  draft: number
  ready: number
  submitted: number
  response_received: number
  interviewing: number
  rejected: number
  offer: number
}

interface StatsResponse {
  newJobsToday: number
  pendingQuestions: number
  inProgress: number
  interviewing: number
  pipeline: PipelineCounts
  jobsByStatus: Record<string, number>
  totalJobs: number
  totalApplications: number
  recentActivity: Array<{
    id: number
    text: string
    date: string
    icon: string
    type: string
  }>
}

const stats = ref({
  newJobsToday: 0,
  pendingQuestions: 0,
  inProgress: 0,
  interviewing: 0,
})

const pipelineCounts = ref<PipelineCounts>({
  draft: 0,
  ready: 0,
  submitted: 0,
  response_received: 0,
  interviewing: 0,
  rejected: 0,
  offer: 0,
})

const recentActivity = ref<Array<{ id: number; text: string; date: string; icon: string }>>([])
const loading = ref(true)

async function fetchStats() {
  loading.value = true
  try {
    const data = await $fetch<StatsResponse>('/api/stats')
    stats.value = {
      newJobsToday: data.newJobsToday,
      pendingQuestions: data.pendingQuestions,
      inProgress: data.inProgress,
      interviewing: data.interviewing,
    }
    pipelineCounts.value = data.pipeline
    recentActivity.value = data.recentActivity
  } catch (e) {
    console.error('Failed to fetch stats:', e)
  } finally {
    loading.value = false
  }
}

const statCards = computed(() => [
  { title: 'New Jobs Today', value: stats.value.newJobsToday, icon: 'mdi-new-box', color: 'accent' },
  { title: 'Pending Questions', value: stats.value.pendingQuestions, icon: 'mdi-help-circle', color: 'warning' },
  { title: 'Applications In Progress', value: stats.value.inProgress, icon: 'mdi-send-check', color: 'primary' },
  { title: 'Interview Stage', value: stats.value.interviewing, icon: 'mdi-account-tie', color: 'success' },
])

function formatDate(dateStr: string) {
  const date = new Date(dateStr)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const hours = Math.floor(diff / (1000 * 60 * 60))
  if (hours < 1) return 'Just now'
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return date.toLocaleDateString()
}

onMounted(fetchStats)
</script>

<template>
  <div>
    <div class="d-flex align-center justify-space-between mb-6">
      <h1 class="text-h4 font-weight-bold">Dashboard</h1>
      <v-btn color="primary" prepend-icon="mdi-play-circle" to="/jobs">
        Start Daily Review
      </v-btn>
    </div>

    <!-- Stats Row -->
    <v-row class="mb-6">
      <v-col v-for="stat in statCards" :key="stat.title" cols="12" sm="6" md="3">
        <v-card variant="outlined">
          <v-card-text class="d-flex align-center ga-4">
            <v-avatar :color="stat.color" variant="tonal" size="48">
              <v-icon :icon="stat.icon" size="24" />
            </v-avatar>
            <div>
              <div class="text-h5 font-weight-bold">{{ stat.value }}</div>
              <div class="text-body-2 text-medium-emphasis">{{ stat.title }}</div>
            </div>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <!-- Application Pipeline -->
    <div class="mb-6">
      <ApplicationsStatusPipeline :counts="pipelineCounts" />
    </div>

    <!-- Recent Activity -->
    <v-card variant="outlined">
      <v-card-item>
        <v-card-title class="text-subtitle-1 font-weight-medium">
          Recent Activity
        </v-card-title>
      </v-card-item>
      <v-card-text>
        <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-4" />

        <template v-if="recentActivity.length">
          <v-list>
            <v-list-item
              v-for="activity in recentActivity"
              :key="`${activity.type}-${activity.id}`"
              :prepend-icon="activity.icon"
            >
              <v-list-item-title>{{ activity.text }}</v-list-item-title>
              <v-list-item-subtitle>{{ formatDate(activity.date) }}</v-list-item-subtitle>
            </v-list-item>
          </v-list>
        </template>

        <div v-else-if="!loading" class="text-center pa-8">
          <v-icon icon="mdi-information-outline" size="48" color="secondary" class="mb-3" />
          <p class="text-body-1 text-medium-emphasis">
            No recent activity. Start by setting up your search configuration.
          </p>
          <v-btn variant="tonal" color="primary" prepend-icon="mdi-cog" to="/settings" class="mt-2">
            Go to Settings
          </v-btn>
        </div>
      </v-card-text>
    </v-card>
  </div>
</template>

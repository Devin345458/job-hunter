<script setup lang="ts">
definePageMeta({ layout: 'default' })

const { success } = useSnackbar()

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
  totalJobs: 0,
  totalApplications: 0,
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

const recentActivity = ref<Array<{ id: number; text: string; date: string; icon: string; type: string }>>([])
const loading = ref(true)

const isNewUser = computed(() =>
  !loading.value
  && stats.value.totalJobs === 0
  && stats.value.totalApplications === 0,
)

async function fetchStats() {
  loading.value = true
  try {
    const data = await $fetch<StatsResponse>('/api/stats')
    stats.value = {
      newJobsToday: data.newJobsToday,
      pendingQuestions: data.pendingQuestions,
      inProgress: data.inProgress,
      interviewing: data.interviewing,
      totalJobs: data.totalJobs ?? 0,
      totalApplications: data.totalApplications ?? 0,
    }
    pipelineCounts.value = data.pipeline
    recentActivity.value = data.recentActivity
  }
  catch (e) {
    console.error('Failed to fetch stats:', e)
  }
  finally {
    loading.value = false
  }
}

const statCards = computed(() => [
  { title: 'New Jobs Today', value: stats.value.newJobsToday, icon: 'mdi-lightning-bolt', color: 'accent', to: '/jobs' },
  { title: 'Pending Questions', value: stats.value.pendingQuestions, icon: 'mdi-chat-processing-outline', color: 'warning', to: '/questions' },
  { title: 'In Progress', value: stats.value.inProgress, icon: 'mdi-send-check', color: 'primary', to: '/applications' },
  { title: 'Interviewing', value: stats.value.interviewing, icon: 'mdi-account-tie', color: 'success', to: '/applications' },
])

interface SetupStep {
  title: string
  description: string
  icon: string
  to: string
  action: string
  done: boolean
}

const knowledgeCount = ref(0)
const configCount = ref(0)

async function fetchSetupData() {
  try {
    const [knowledge, configs] = await Promise.all([
      $fetch<any[]>('/api/knowledge').catch(() => []),
      $fetch<any[]>('/api/search-configs').catch(() => []),
    ])
    knowledgeCount.value = Array.isArray(knowledge) ? knowledge.length : 0
    configCount.value = Array.isArray(configs) ? configs.length : 0
  }
  catch {
    // Non-critical
  }
}

const setupSteps = computed<SetupStep[]>(() => [
  {
    title: 'Add your professional knowledge',
    description: 'Import your resume or manually add your skills, experience, and preferences. This powers the AI matching and resume tailoring.',
    icon: 'mdi-lightbulb-outline',
    to: '/knowledge',
    action: 'Go to Knowledge Base',
    done: knowledgeCount.value > 0,
  },
  {
    title: 'Configure job searches',
    description: 'Set up search profiles with keywords, locations, salary requirements, and preferred job sources.',
    icon: 'mdi-tune-variant',
    to: '/settings',
    action: 'Go to Settings',
    done: configCount.value > 0,
  },
  {
    title: 'Run your first search',
    description: 'Trigger a manual search to find matching jobs, or wait for the daily automated search at 6 AM.',
    icon: 'mdi-magnify',
    to: '/settings',
    action: 'Run Search',
    done: stats.value.totalJobs > 0,
  },
  {
    title: 'Review and apply',
    description: 'Browse matched jobs, review AI scoring, and generate tailored resumes for positions that interest you.',
    icon: 'mdi-file-document-edit-outline',
    to: '/jobs',
    action: 'Browse Jobs',
    done: stats.value.totalApplications > 0,
  },
])

const setupProgress = computed(() => {
  const done = setupSteps.value.filter(s => s.done).length
  return Math.round((done / setupSteps.value.length) * 100)
})

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

onMounted(async () => {
  await Promise.all([fetchStats(), fetchSetupData()])
})
</script>

<template>
  <div class="fade-in">
    <!-- Page Header -->
    <div class="d-flex align-center justify-space-between mb-8">
      <div class="page-header">
        <h1 class="text-h4 page-header__title">Dashboard</h1>
        <p class="text-body-2 page-header__subtitle">
          Your job search at a glance. Review new matches, track applications, and stay on top of your pipeline.
        </p>
      </div>
      <v-btn
        color="primary"
        prepend-icon="mdi-play-circle"
        to="/jobs"
        class="d-none d-sm-flex"
      >
        Review Jobs
      </v-btn>
    </div>

    <!-- Getting Started Guide (for new users or incomplete setup) -->
    <v-card
      v-if="!loading && setupProgress < 100"
      variant="outlined"
      class="mb-8 glow-primary"
    >
      <v-card-item>
        <template #prepend>
          <v-avatar color="primary" variant="tonal" size="40">
            <v-icon icon="mdi-rocket-launch-outline" />
          </v-avatar>
        </template>
        <v-card-title class="text-subtitle-1 font-weight-bold">
          {{ isNewUser ? 'Welcome to Job Hunter' : 'Setup Progress' }}
        </v-card-title>
        <v-card-subtitle>
          {{ isNewUser
            ? 'Let\'s get you set up. Complete these steps to start your AI-powered job search.'
            : `${setupSteps.filter(s => s.done).length} of ${setupSteps.length} steps complete`
          }}
        </v-card-subtitle>
        <template #append>
          <v-progress-circular
            :model-value="setupProgress"
            :size="44"
            :width="4"
            color="primary"
          >
            <span class="text-caption font-weight-bold">{{ setupProgress }}%</span>
          </v-progress-circular>
        </template>
      </v-card-item>

      <v-card-text class="pt-0">
        <v-list density="compact" class="bg-transparent">
          <v-list-item
            v-for="(step, idx) in setupSteps"
            :key="idx"
            :to="step.to"
            rounded="lg"
            class="mb-1"
          >
            <template #prepend>
              <v-icon
                :icon="step.done ? 'mdi-check-circle' : step.icon"
                :color="step.done ? 'success' : 'default'"
                size="20"
                class="mr-3"
                :style="{ opacity: step.done ? 1 : 0.5 }"
              />
            </template>
            <v-list-item-title
              class="text-body-2"
              :class="{ 'text-medium-emphasis text-decoration-line-through': step.done }"
            >
              {{ step.title }}
            </v-list-item-title>
            <v-list-item-subtitle class="text-caption">
              {{ step.description }}
            </v-list-item-subtitle>
            <template v-if="!step.done" #append>
              <v-btn
                variant="tonal"
                color="primary"
                size="x-small"
                :to="step.to"
              >
                {{ step.action }}
              </v-btn>
            </template>
          </v-list-item>
        </v-list>
      </v-card-text>
    </v-card>

    <!-- Stats Row -->
    <v-row class="mb-6 stagger-in">
      <v-col v-for="stat in statCards" :key="stat.title" cols="12" sm="6" md="3">
        <v-card
          variant="outlined"
          :to="stat.to"
          class="card-hover"
        >
          <v-card-text class="d-flex align-center ga-4 pa-5">
            <v-avatar :color="stat.color" variant="tonal" size="48">
              <v-icon :icon="stat.icon" size="22" />
            </v-avatar>
            <div>
              <div class="text-h5 font-weight-bold" style="letter-spacing: -0.02em;">
                {{ stat.value }}
              </div>
              <div class="text-caption text-medium-emphasis">{{ stat.title }}</div>
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
        <v-card-subtitle>
          Latest events across your job search
        </v-card-subtitle>
      </v-card-item>
      <v-card-text>
        <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-4" />

        <template v-if="recentActivity.length">
          <v-list density="compact" class="bg-transparent">
            <v-list-item
              v-for="activity in recentActivity"
              :key="`${activity.type}-${activity.id}`"
              :prepend-icon="activity.icon"
              rounded="lg"
            >
              <v-list-item-title class="text-body-2">{{ activity.text }}</v-list-item-title>
              <v-list-item-subtitle class="text-caption">{{ formatDate(activity.date) }}</v-list-item-subtitle>
            </v-list-item>
          </v-list>
        </template>

        <div v-else-if="!loading" class="text-center pa-10">
          <v-icon icon="mdi-timeline-clock-outline" size="48" class="mb-3" style="opacity: 0.3;" />
          <p class="text-body-2 text-medium-emphasis mb-1">
            No activity yet
          </p>
          <p class="text-caption text-medium-emphasis">
            Activity will appear here as you search for jobs, create applications, and track your progress.
          </p>
        </div>
      </v-card-text>
    </v-card>
  </div>
</template>

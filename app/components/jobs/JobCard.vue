<script setup lang="ts">
import type { Job, JobStatus } from '~/composables/useJobs'

const props = defineProps<{
  job: Job
}>()

const emit = defineEmits<{
  click: [job: Job]
}>()

const statusColors: Record<JobStatus, string> = {
  new: 'info',
  reviewed: 'primary',
  applied: 'success',
  rejected: 'error',
  expired: 'grey',
}

const tags = computed(() => {
  if (!props.job.tags) return []
  try {
    return JSON.parse(props.job.tags) as string[]
  }
  catch {
    return []
  }
})

function formatSalary(min?: number | null, max?: number | null, currency?: string | null): string {
  if (!min && !max) return ''
  const c = currency || 'USD'
  const symbol = c === 'USD' ? '$' : c

  const fmt = (val: number) => {
    if (val >= 1000) return `${symbol}${Math.round(val / 1000)}K`
    return `${symbol}${val}`
  }

  if (min && max) return `${fmt(min)} - ${fmt(max)}`
  if (min) return `${fmt(min)}+`
  if (max) return `Up to ${fmt(max)}`
  return ''
}

const salaryDisplay = computed(() =>
  formatSalary(props.job.salaryMin, props.job.salaryMax, props.job.salaryCurrency),
)
</script>

<template>
  <v-card
    class="job-card"
    :class="{ 'job-card--hover': true }"
    @click="emit('click', job)"
  >
    <v-card-item>
      <template #prepend>
        <JobsMatchScoreBadge
          v-if="job.matchScore != null"
          :score="job.matchScore"
          size="small"
        />
      </template>

      <v-card-title class="text-h6">
        {{ job.title }}
      </v-card-title>

      <v-card-subtitle>
        {{ job.company }}
        <span v-if="job.location" class="ml-2">
          <v-icon size="x-small" icon="mdi-map-marker" />
          {{ job.location }}
        </span>
      </v-card-subtitle>

      <template #append>
        <v-chip
          :color="statusColors[job.status as JobStatus] || 'grey'"
          size="small"
          variant="tonal"
        >
          {{ job.status }}
        </v-chip>
      </template>
    </v-card-item>

    <v-card-text>
      <div class="d-flex flex-wrap align-center ga-2 mb-2">
        <v-chip
          v-if="job.remoteType"
          size="small"
          variant="outlined"
          :prepend-icon="job.remoteType === 'remote' ? 'mdi-earth' : job.remoteType === 'hybrid' ? 'mdi-home-city' : 'mdi-office-building'"
        >
          {{ job.remoteType }}
        </v-chip>

        <v-chip
          v-if="salaryDisplay"
          size="small"
          variant="outlined"
          prepend-icon="mdi-currency-usd"
        >
          {{ salaryDisplay }}
        </v-chip>
      </div>

      <div v-if="tags.length" class="d-flex flex-wrap ga-1">
        <v-chip
          v-for="tag in tags.slice(0, 6)"
          :key="tag"
          size="x-small"
          variant="tonal"
          color="secondary"
        >
          {{ tag }}
        </v-chip>
        <v-chip
          v-if="tags.length > 6"
          size="x-small"
          variant="text"
        >
          +{{ tags.length - 6 }} more
        </v-chip>
      </div>
    </v-card-text>
  </v-card>
</template>

<style scoped lang="scss">
.job-card {
  cursor: pointer;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));

  &--hover:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  }
}
</style>

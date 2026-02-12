<script setup lang="ts">
import type { ApplicationWithJob, ApplicationStatus } from '~/composables/useApplications'

const props = defineProps<{
  application: ApplicationWithJob
}>()

const router = useRouter()

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

const dateApplied = computed(() => {
  if (!props.application.submittedAt) return null
  return new Date(props.application.submittedAt).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
})

const dateCreated = computed(() => {
  return new Date(props.application.createdAt).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
})

function navigateToDetail() {
  router.push(`/applications/${props.application.id}`)
}
</script>

<template>
  <v-card
    class="application-card"
    @click="navigateToDetail"
  >
    <v-card-item>
      <template #prepend>
        <JobsMatchScoreBadge
          v-if="application.job?.matchScore != null"
          :score="application.job.matchScore"
          size="small"
        />
      </template>

      <v-card-title>{{ application.job?.title || 'Unknown Role' }}</v-card-title>
      <v-card-subtitle>{{ application.job?.company || 'Unknown Company' }}</v-card-subtitle>

      <template #append>
        <v-chip
          :color="statusColors[application.status as ApplicationStatus] || 'grey'"
          size="small"
          variant="tonal"
        >
          {{ statusLabels[application.status as ApplicationStatus] || application.status }}
        </v-chip>
      </template>
    </v-card-item>

    <v-card-text class="d-flex align-center ga-4 text-body-2 text-medium-emphasis">
      <span v-if="dateApplied">
        <v-icon size="x-small" icon="mdi-send" class="mr-1" />
        Applied {{ dateApplied }}
      </span>
      <span v-else>
        <v-icon size="x-small" icon="mdi-calendar-plus" class="mr-1" />
        Created {{ dateCreated }}
      </span>

      <span v-if="application.job?.location">
        <v-icon size="x-small" icon="mdi-map-marker" class="mr-1" />
        {{ application.job.location }}
      </span>
    </v-card-text>
  </v-card>
</template>

<style scoped lang="scss">
.application-card {
  cursor: pointer;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));

  &:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
  }
}
</style>

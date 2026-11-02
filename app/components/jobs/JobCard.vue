<script setup lang="ts">
import type { JobListItem } from '~/composables/useJobs'
import { ATS_LABELS, formatMoneyShort, jobStateMeta, postingLocations, uniqueTags } from './format'

const props = defineProps<{
  job: JobListItem
}>()

/** The application's state when the job has one ("In review"), else the job's own status. */
const state = computed(() => jobStateMeta(props.job.status, props.job.application))

const tags = computed(() => uniqueTags(props.job.tags))

// One card can stand for several postings of the same role at the same company.
const postingCount = computed(() => props.job.postingCount ?? 1)
const locations = computed(() => (postingCount.value > 1 ? postingLocations(props.job.postings ?? []) : []))
const locationText = computed(() => (postingCount.value > 1 && locations.value.length ? locations.value.join(' · ') : props.job.location))

const salaryDisplay = computed(() => {
  const { salaryMin: min, salaryMax: max, salaryCurrency } = props.job
  if (!min && !max) return ''
  const c = salaryCurrency || 'USD'
  const symbol = c === 'USD' ? '$' : `${c} `
  const fmt = (val: number) => (val >= 1000 ? `${symbol}${Math.round(val / 1000)}K` : `${symbol}${val}`)
  if (min && max) return `${fmt(min)} to ${fmt(max)}`
  if (min) return `${fmt(min)}+`
  return `Up to ${fmt(max!)}`
})

const remoteIcon = computed(() =>
  props.job.remoteType === 'remote' ? 'mdi-earth' : props.job.remoteType === 'hybrid' ? 'mdi-home-city' : 'mdi-office-building',
)
</script>

<template>
  <!-- A real link: middle click and "open in new tab" work, and screen readers announce it as one. -->
  <v-card
    :to="`/jobs/${job.id}`"
    variant="outlined"
    class="job-card card-hover"
  >
    <div class="job-card__head">
      <JobsMatchScoreBadge
        v-if="job.matchScore != null"
        :score="job.matchScore"
        size="small"
      />
      <div class="job-card__heading">
        <h3 class="job-card__title" :title="job.title">
          {{ job.title }}
        </h3>
        <div class="job-card__company">
          {{ job.company }}
        </div>
        <div v-if="locationText" class="job-card__location" :title="locationText">
          <v-icon size="14" icon="mdi-map-marker-outline" aria-hidden="true" />
          <span class="job-card__location-text">{{ locationText }}</span>
        </div>
      </div>
    </div>

    <div class="job-card__facts">
      <v-chip
        :color="state.color"
        size="small"
        variant="tonal"
      >
        {{ state.label }}
      </v-chip>

      <v-chip
        v-if="postingCount > 1"
        size="small"
        variant="outlined"
        prepend-icon="mdi-layers-outline"
        :aria-label="`${postingCount} postings of this role: ${locations.join(', ') || 'same location'}`"
      >
        {{ postingCount }} postings
      </v-chip>

      <v-chip
        v-if="job.isSandbox"
        size="small"
        variant="tonal"
        color="warning"
        prepend-icon="mdi-flask-outline"
      >
        Sandbox
      </v-chip>

      <v-chip
        v-if="job.remoteType"
        size="small"
        variant="outlined"
        :prepend-icon="remoteIcon"
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

      <v-chip
        v-if="job.totalCompEstimate"
        size="small"
        variant="tonal"
        color="primary"
      >
        About {{ formatMoneyShort(job.totalCompEstimate) }} total
      </v-chip>

      <v-chip
        v-if="job.applyUrl"
        size="small"
        variant="tonal"
        color="secondary"
        prepend-icon="mdi-form-select"
      >
        {{ ATS_LABELS[job.atsType ?? 'other'] ?? 'Employer form' }} form
      </v-chip>
    </div>

    <div v-if="tags.length" class="job-card__tags">
      <v-chip
        v-for="tag in tags.slice(0, 4)"
        :key="tag"
        size="x-small"
        variant="tonal"
        color="secondary"
      >
        {{ tag }}
      </v-chip>
      <span v-if="tags.length > 4" class="job-card__more">+{{ tags.length - 4 }} more</span>
    </div>
  </v-card>
</template>

<style scoped lang="scss">
.job-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  padding: 16px;

  &__head {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    min-width: 0;
  }

  &__heading {
    flex: 1 1 auto;
    min-width: 0;
  }

  // Two lines before it clips, so postings that differ only at the end of the title, such as
  // "Senior Full-Stack Engineer (Sandbox onsite A)" and "(Sandbox onsite B)", stay distinguishable
  // on a phone. The full title is in the title attribute and on the detail page.
  &__title {
    font-size: 1rem;
    font-weight: 650;
    line-height: 1.35;
    letter-spacing: -0.01em;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
  }

  &__company {
    margin-top: 2px;
    font-size: 0.875rem;
    font-weight: 500;
    line-height: 1.4;
    overflow-wrap: anywhere;
    color: rgba(var(--v-theme-on-surface), var(--v-high-emphasis-opacity));
  }

  &__location {
    display: flex;
    align-items: flex-start;
    gap: 4px;
    margin-top: 2px;
    font-size: 0.8125rem;
    line-height: 1.4;
    overflow-wrap: anywhere;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));

    .v-icon {
      margin-top: 2px;
      flex-shrink: 0;
    }
  }

  // A grouped card lists every posting's location; two lines, then the title attribute has the rest.
  &__location-text {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  &__facts,
  &__tags {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }

  &__more {
    font-size: 0.75rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }
}
</style>

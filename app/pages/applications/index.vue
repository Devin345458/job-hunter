<script setup lang="ts">
import type { ApplicationWithJob } from '~/composables/useApplications'
import { STAGES, type StageKey } from '~/components/applications/StatusPipeline.vue'

// Every application the pipeline prepared or Devin tracked, newest first, filtered by stage.
// Deciding happens on the review queue; this list is the record.
definePageMeta({ layout: 'default' })
useHead({ title: 'Applications · Job Hunter' })

const { applications, loading, error, fetchApplications } = useApplications()
const search = ref('')
const stage = ref<StageKey>('all')

const stageOf = (status: string): StageKey => STAGES.find(s => s.key !== 'all' && s.statuses.includes(status))?.key ?? 'closed'

const counts = computed(() => {
  const c = Object.fromEntries(STAGES.map(s => [s.key, 0])) as Record<StageKey, number>
  for (const a of applications.value) {
    c.all++
    c[stageOf(a.status)]++
  }
  return c
})

const shown = computed(() => {
  const q = search.value.trim().toLowerCase()
  return applications.value.filter((a: ApplicationWithJob) =>
    (stage.value === 'all' || stageOf(a.status) === stage.value)
    && (!q || `${a.job?.company ?? ''} ${a.job?.title ?? ''}`.toLowerCase().includes(q)))
})

async function load() {
  try {
    await fetchApplications({ limit: 100 })
  }
  catch {
    // error is shown from the composable
  }
}
onMounted(load)
</script>

<template>
  <div class="al">
    <header class="al__head">
      <h1 class="al__title">Applications</h1>
      <p class="al__sub">Everything the pipeline prepared: tailored resume, cover letter, and the employer form filled but never sent. Only Approve on the review queue submits.</p>
    </header>

    <ApplicationsStatusPipeline v-model="stage" :counts="counts" class="al__stages" />

    <v-text-field
      v-model="search"
      label="Search by company or role"
      prepend-inner-icon="mdi-magnify"
      clearable
      hide-details
      class="al__search"
    />

    <div v-if="error" class="al__error" role="alert">
      <span>Could not load applications: {{ error }}</span>
      <v-btn variant="outlined" height="44" prepend-icon="mdi-refresh" @click="load">Try again</v-btn>
    </div>

    <v-skeleton-loader v-if="loading && !applications.length" type="list-item-three-line@4" class="al__skel" />

    <div v-else-if="shown.length" class="al__list">
      <ApplicationsApplicationCard v-for="a in shown" :key="a.id" :application="a" />
    </div>

    <div v-else-if="!loading && !error" class="al__empty">
      <v-icon icon="mdi-file-document-outline" size="28" />
      <p v-if="applications.length" class="al__empty-text">Nothing in this stage{{ search ? ' matches the search' : '' }}.</p>
      <p v-else class="al__empty-text">No applications yet. The daily run prepares one for every strong match with an application link, or start one from a job's page.</p>
      <v-btn variant="outlined" height="44" to="/jobs" prepend-icon="mdi-briefcase-search-outline">Browse jobs</v-btn>
    </div>
  </div>
</template>

<style scoped lang="scss">
.al {
  max-width: 920px;
  margin: 0 auto;
  padding: 8px 0 32px;

  &__head { margin-bottom: 16px; }
  &__title { font-size: 1.75rem; font-weight: 700; letter-spacing: -0.02em; margin: 0 0 6px; }
  &__sub { margin: 0; font-size: 0.875rem; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); max-width: 640px; }
  &__stages { margin-bottom: 12px; }
  &__search { margin-bottom: 12px; }

  &__error {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 10px 12px;
    margin-bottom: 12px;
    border-radius: 8px;
    font-size: 0.875rem;
    color: rgb(var(--v-theme-error));
    background: rgba(var(--v-theme-error), 0.08);
    border: 1px solid rgba(var(--v-theme-error), 0.3);
  }

  &__skel, &__list {
    border-radius: 12px;
    overflow: hidden;
    background: rgb(var(--v-theme-surface));
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  }

  &__list > :last-child { border-bottom: 0; }

  &__empty {
    display: grid;
    justify-items: start;
    gap: 8px;
    padding: 24px;
    border-radius: 12px;
    background: rgb(var(--v-theme-surface));
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__empty-text { margin: 0; font-size: 0.875rem; }
}
</style>

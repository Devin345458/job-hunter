<script setup lang="ts">
import type { ApplicationWithJob } from '~/composables/useApplications'
import { STAGES, type StageKey } from '~/components/applications/StatusPipeline.vue'
import { HEARD_BACK_STATUSES, SENT_STATUSES } from '#shared/utils/outcomes'
import { countText } from '#shared/utils/pay-format'

// Every application the pipeline prepared or Devin tracked, newest first, filtered by stage.
// Deciding happens on the review queue; this list is the record.
definePageMeta({ layout: 'default' })
useHead({ title: 'Applications · Job Hunter' })

const { applications, loading, error, fetchApplications } = useApplications()
// Vuetify's clear button sets a clearable field's model to null, not ''.
const search = ref<string | null>('')
// One filter at a time: a stage chip, or an outcome chip under "After sending".
const filter = ref<StageKey | OutcomeFilterKey>('all')
const isStage = (key: string): key is StageKey => STAGES.some(s => s.key === key)
const stage = computed<StageKey | null>({
  get: () => (isStage(filter.value) ? filter.value : null),
  set: (v) => { if (v) filter.value = v },
})

const stageOf = (status: string): StageKey => STAGES.find(s => s.key !== 'all' && s.statuses.includes(status))?.key ?? 'closed'

const counts = computed(() => {
  const c = Object.fromEntries(STAGES.map(s => [s.key, 0])) as Record<StageKey, number>
  for (const a of applications.value) {
    c.all++
    c[stageOf(a.status)]++
  }
  return c
})

// ── After sending: what employers did ──
type OutcomeFilterKey = 'waiting' | 'response_received' | 'interviewing' | 'offer' | 'rejected' | 'no_response'
const OUTCOME_FILTERS: Array<{ key: OutcomeFilterKey; label: string; status: string }> = [
  { key: 'waiting', label: 'Waiting to hear back', status: 'submitted' },
  { key: 'response_received', label: 'Heard back', status: 'response_received' },
  { key: 'interviewing', label: 'Interviewing', status: 'interviewing' },
  { key: 'offer', label: 'Offers', status: 'offer' },
  { key: 'rejected', label: 'Rejected by employer', status: 'rejected' },
  { key: 'no_response', label: 'No response', status: 'no_response' },
]
// The outcome chips count and filter real applications only, so they agree with the line above them.
// Sandbox tests that took an outcome stay under the Submitted and Closed stages, tagged Sandbox.
const outcomeCounts = computed(() => Object.fromEntries(OUTCOME_FILTERS.map(f => [f.key, applications.value.filter(a => !a.isSandbox && a.status === f.status).length])) as Record<OutcomeFilterKey, number>)

/** "12 sent, 3 heard back, 1 interviewing": real applications only, sandbox tests named apart. */
const sentLine = computed(() => {
  const real = applications.value.filter(a => !a.isSandbox)
  const n = (statuses: readonly string[]) => real.filter(a => statuses.includes(a.status)).length
  const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
  return [
    `${n(SENT_STATUSES)} sent`,
    `${n(HEARD_BACK_STATUSES)} heard back`,
    `${n(['interviewing'])} interviewing`,
    plural(n(['offer']), 'offer', 'offers'),
    `${n(['rejected'])} rejected`,
    `${n(['submitted'])} waiting to hear back`,
  ].join(', ')
})
const sandboxSent = computed(() => applications.value.filter(a => a.isSandbox && SENT_STATUSES.includes(a.status as any)).length)
/** Something real was sent: only then does the After sending row have anything to filter. */
const anySent = computed(() => applications.value.some(a => !a.isSandbox && SENT_STATUSES.includes(a.status as any)))
/** The page's one line about the data. */
const dataLine = computed(() => {
  const n = applications.value.length
  if (!n) return ''
  const sent = applications.value.filter(a => !a.isSandbox && SENT_STATUSES.includes(a.status as any)).length
  return `${countText(n)} application${n === 1 ? '' : 's'}, ${sent ? `${countText(sent)} sent` : 'none sent yet'}`
})

const shown = computed(() => {
  const q = (search.value ?? '').trim().toLowerCase()
  const f = filter.value
  const outcome = OUTCOME_FILTERS.find(o => o.key === f)
  return applications.value.filter((a: ApplicationWithJob) =>
    (outcome ? !a.isSandbox && a.status === outcome.status : f === 'all' || stageOf(a.status) === f)
    && (!q || `${a.job?.company ?? ''} ${a.job?.title ?? ''}`.toLowerCase().includes(q)))
})

/** Null until the list loads; then whether approve submits to real employers on its own. */
const realSubmit = ref<boolean | null>(null)

async function load() {
  try {
    const data = await fetchApplications({ limit: 100 })
    realSubmit.value = data.realSubmitEnabled ?? false
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
      <p class="al__sub">{{ dataLine || '\u00a0' }}</p>
    </header>

    <ApplicationsStatusPipeline v-model="stage" :counts="counts" class="al__stages" />

    <section v-if="anySent" class="al__after" aria-labelledby="al-after-title">
      <p class="al__after-line">
        <span id="al-after-title" class="al__after-title">After sending:</span> {{ sentLine }}.
        <span v-if="sandboxSent" class="al__after-muted">{{ sandboxSent }} sandbox {{ sandboxSent === 1 ? 'test is' : 'tests are' }} left out of these counts and filters.</span>
      </p>
      <div class="al__after-chips" role="tablist" aria-label="Filter sent applications by what the employer did">
        <button
          v-for="o in OUTCOME_FILTERS"
          :key="o.key"
          type="button"
          role="tab"
          class="al__chip"
          :class="{ 'al__chip--on': filter === o.key }"
          :aria-selected="filter === o.key"
          @click="filter = filter === o.key ? 'all' : o.key"
        >
          {{ o.label }}
          <span class="al__chip-count">{{ countText(outcomeCounts[o.key]) }}</span>
        </button>
      </div>
    </section>

    <v-text-field
      v-model="search"
      placeholder="Search by company or role"
      aria-label="Search by company or role"
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
      <ApplicationsApplicationCard v-for="a in shown" :key="a.id" :application="a" @changed="load" />
    </div>

    <div v-else-if="!loading && !error" class="al__empty">
      <v-icon icon="mdi-file-document-outline" size="28" />
      <p v-if="applications.length" class="al__empty-text">Nothing {{ isStage(filter) ? 'in this stage' : 'with this outcome' }}{{ search ? ' matches the search' : '' }}.</p>
      <p v-else class="al__empty-text">No applications yet. Each scheduled run prepares one for every strong match with an application link, or start one from a job's page.</p>
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
  &__title { font-size: 1.5rem; font-weight: 600; letter-spacing: -0.015em; line-height: 1.25; margin: 0 0 4px; }
  &__sub { margin: 0; font-size: 0.875rem; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); max-width: 640px; }
  &__stages { margin-bottom: 12px; }

  &__after {
    margin-bottom: 12px;
    padding: 12px 14px;
    border-radius: 10px;
    background: rgb(var(--v-theme-surface));
  }

  &__after-line { margin: 0 0 10px; font-size: 0.875rem; }
  &__after-title { font-weight: 600; }
  &__after-muted { color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
  &__after-chips { display: flex; flex-wrap: wrap; gap: 6px; }

  &__chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 36px;
    padding: 0 12px;
    border-radius: 8px;
    font-size: 0.8125rem;
    font-weight: 500;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    background: rgb(var(--v-theme-surface-bright));
    transition: background-color 150ms cubic-bezier(0.23, 1, 0.32, 1), color 150ms cubic-bezier(0.23, 1, 0.32, 1);

    &:hover { color: rgb(var(--v-theme-on-surface)); }
    &:focus-visible { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: 2px; }

    &--on {
      color: rgb(var(--v-theme-on-surface));
      background: rgb(var(--v-theme-surface-light));
    }
  }

  &__chip-count {
    font-size: 0.75rem;
    min-width: 20px;
    padding: 1px 6px;
    border-radius: 6px;
    text-align: center;
    background: rgb(var(--v-theme-surface));
  }
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
    border-radius: 16px;
    overflow: hidden;
    background: rgb(var(--v-theme-surface));
  }

  &__list > :last-child { border-bottom: 0; }

  &__empty {
    display: grid;
    justify-items: start;
    gap: 8px;
    padding: 24px;
    border-radius: 16px;
    background: rgb(var(--v-theme-surface));
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__empty-text { margin: 0; font-size: 0.875rem; }
}
</style>

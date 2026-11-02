<script setup lang="ts">
import type { LearnedRuleView, LearningOverview, ScoreMoveView } from '#shared/types/learning'
import type { PipelineRunView } from '#shared/types/pipeline'

definePageMeta({ layout: 'default' })

const snackbar = useSnackbar()

const overview = ref<LearningOverview | null>(null)
const moves = ref<ScoreMoveView[]>([])
const loading = ref(true)
const loadError = ref<string | null>(null)
const running = ref(false)
const toggling = ref<Record<number, boolean>>({})

const realRules = computed(() => overview.value?.rules.filter(r => !r.isSandbox) ?? [])
const sandboxRules = computed(() => overview.value?.rules.filter(r => r.isSandbox) ?? [])
const activeCount = computed(() => overview.value?.rules.filter(r => r.active).length ?? 0)
const search = computed(() => overview.value?.search)
const searchEmpty = computed(() => !search.value || (search.value.excludedCompanies.length + search.value.excludedKeywords.length + search.value.boostKeywords.length) === 0)

/** Stored times are UTC without a zone ("2026-11-01 15:28:56"). */
function when(s: string | null | undefined) {
  if (!s) return ''
  const d = new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`)
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function signed(n: number) {
  return n > 0 ? `+${n}` : `${n}`
}

function moveReason(r: string) {
  if (r === 'rule_change') return 'Learned rule changed'
  if (r === 'rescore') return 'Rescored after an answer'
  return r
}

async function load() {
  loadError.value = null
  try {
    const [o, m] = await Promise.all([
      $fetch<LearningOverview>('/api/learning/overview'),
      $fetch<{ moves: ScoreMoveView[] }>('/api/learning/moves', { params: { limit: 30 } }),
    ])
    overview.value = o
    moves.value = m.moves
  }
  catch (e: any) {
    loadError.value = e?.data?.statusMessage || e?.message || 'Could not load what the pipeline learned'
  }
  finally {
    loading.value = false
  }
}

async function toggle(rule: LearnedRuleView, active: boolean) {
  const before = rule.active
  rule.active = active // optimistic; reverted below on failure
  toggling.value[rule.id] = true
  try {
    const out = await $fetch<{ rule: LearnedRuleView | null; rescored: number }>(`/api/learning/rules/${rule.id}`, {
      method: 'PATCH',
      body: { active },
    })
    if (out.rule) Object.assign(rule, out.rule)
    const moved = out.rescored ? ` ${out.rescored} ${out.rescored === 1 ? 'job' : 'jobs'} rescored.` : ''
    snackbar.success(`${active ? 'Rule on.' : 'Rule off.'}${moved}`)
    if (out.rescored) {
      moves.value = (await $fetch<{ moves: ScoreMoveView[] }>('/api/learning/moves', { params: { limit: 30 } })).moves
    }
  }
  catch (e: any) {
    rule.active = before
    snackbar.error(e?.data?.statusMessage || 'Could not change that rule')
  }
  finally {
    toggling.value[rule.id] = false
  }
}

async function runNow() {
  running.value = true
  const previous = overview.value?.lastRun?.id ?? 0
  try {
    await $fetch('/api/pipeline/run', { method: 'POST', body: { task: 'learn:daily' } })
    let run: PipelineRunView | undefined
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 1000))
      const { runs } = await $fetch<{ runs: PipelineRunView[] }>('/api/pipeline/runs', { params: { limit: 20 } })
      run = runs.find(r => r.task === 'learn:daily' && r.id > previous && r.status !== 'running')
      if (run) break
    }
    await load()
    if (!run) snackbar.warning('Learning is still running. Reload in a minute to see the result.')
    else if (run.status === 'failed') snackbar.error(`Learning failed: ${(run.error || '').split('\n')[0]}`)
    else snackbar.success(`Learning ran. ${run.stats?.rescored ?? 0} jobs rescored.`)
  }
  catch (e: any) {
    snackbar.error(e?.data?.statusMessage || 'Could not start learning')
  }
  finally {
    running.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="fade-in learning-page">
    <div class="d-flex flex-wrap align-start justify-space-between ga-4 mb-8">
      <div class="page-header mb-0">
        <h1 class="text-h4 page-header__title">Learning</h1>
        <p class="text-body-2 page-header__subtitle">
          What your approvals and rejections taught the pipeline, and how that changes scores and search.
          Turn off any rule that looks wrong.
        </p>
      </div>
      <div class="d-flex flex-column align-end ga-1 learning-page__run">
        <v-btn color="primary" prepend-icon="mdi-refresh" :loading="running" @click="runNow">Run learning now</v-btn>
        <span v-if="overview?.lastRun" class="text-caption text-medium-emphasis">
          Last run {{ when(overview.lastRun.startedAt) }}<template v-if="overview.lastRun.status === 'failed'">, failed</template>
        </span>
      </div>
    </div>

    <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-6" />

    <v-alert v-if="loadError" type="error" variant="tonal" class="mb-6">
      {{ loadError }}
      <template #append>
        <v-btn variant="text" size="small" @click="load">Try again</v-btn>
      </template>
    </v-alert>

    <template v-if="overview && !loadError">
      <!-- What it learned from -->
      <p class="text-body-1 mb-3 learning-page__lede">
        From <strong>{{ overview.decisions.rejections }} {{ overview.decisions.rejections === 1 ? 'rejection' : 'rejections' }}</strong>
        and <strong>{{ overview.decisions.approvals }} {{ overview.decisions.approvals === 1 ? 'approval' : 'approvals' }}</strong>,
        the pipeline keeps <strong>{{ activeCount }} active {{ activeCount === 1 ? 'rule' : 'rules' }}</strong>.
        <span v-if="overview.decisions.sandbox" class="text-medium-emphasis">{{ overview.decisions.sandbox }} of those decisions were sandbox tests.</span>
      </p>
      <div v-if="overview.decisions.byReason.length" class="d-flex flex-wrap ga-2 mb-8">
        <v-chip v-for="r in overview.decisions.byReason" :key="r.code" size="small" variant="tonal" label>
          {{ r.label }}<span class="learning-page__num ml-2 font-weight-bold">{{ r.count }}</span>
        </v-chip>
      </div>

      <!-- Rules for real jobs -->
      <section class="mb-8">
        <div class="section-label">Rules for your real search</div>
        <v-card v-if="realRules.length === 0" variant="outlined" class="pa-6">
          <p class="text-body-2 text-medium-emphasis mb-0 learning-page__note">
            No rules from real decisions yet. Each approve and reject on the review dashboard adds evidence.
            One rejection moves a score by about 3 points. Five for the same reason move it by about 15.
          </p>
        </v-card>
        <v-card v-else variant="outlined">
          <template v-for="(rule, i) in realRules" :key="rule.id">
            <v-divider v-if="i > 0" />
            <KnowledgeLearnedRuleRow :rule="rule" :busy="!!toggling[rule.id]" @toggle="v => toggle(rule, v)" />
          </template>
        </v-card>
      </section>

      <!-- Sandbox rules -->
      <section v-if="sandboxRules.length" class="mb-8">
        <div class="section-label">Sandbox rules</div>
        <p class="text-body-2 text-medium-emphasis mb-3 learning-page__note">
          Learned from test decisions on sandbox jobs. They score sandbox jobs only and never touch your real search.
        </p>
        <v-card variant="outlined">
          <template v-for="(rule, i) in sandboxRules" :key="rule.id">
            <v-divider v-if="i > 0" />
            <KnowledgeLearnedRuleRow :rule="rule" :busy="!!toggling[rule.id]" @toggle="v => toggle(rule, v)" />
          </template>
        </v-card>
      </section>

      <v-row class="mb-2">
        <!-- Score moves -->
        <v-col cols="12" lg="8">
          <div class="section-label">Recent score moves</div>
          <v-card v-if="moves.length === 0" variant="outlined" class="pa-6">
            <p class="text-body-2 text-medium-emphasis mb-0">No scores have moved yet. They move when a rule changes and learning runs.</p>
          </v-card>
          <v-card v-else variant="outlined">
            <template v-for="(m, i) in moves" :key="m.id">
              <v-divider v-if="i > 0" />
              <div class="move pa-4">
                <div class="move__head d-flex align-start ga-3">
                  <div class="move__job flex-grow-1">
                    <NuxtLink :to="`/jobs/${m.jobId}`" class="move__title tap-inline text-body-2 font-weight-medium">{{ m.jobTitle }}</NuxtLink>
                    <div class="text-caption text-medium-emphasis">
                      {{ m.company }}<v-chip v-if="m.isSandbox" size="x-small" variant="tonal" label class="ml-2">Sandbox</v-chip>
                    </div>
                  </div>
                  <div class="move__scores text-no-wrap" :aria-label="`Score ${m.oldScore ?? 'unknown'} to ${m.newScore}`">
                    <span class="text-medium-emphasis">{{ m.oldScore ?? '?' }}</span>
                    <v-icon icon="mdi-arrow-right" size="16" class="mx-1 text-medium-emphasis" />
                    <span class="font-weight-bold text-body-1">{{ m.newScore }}</span>
                    <v-chip
                      v-if="m.oldScore != null && m.newScore !== m.oldScore"
                      size="x-small"
                      variant="tonal"
                      :color="m.newScore > m.oldScore ? 'success' : 'error'"
                      label
                      class="ml-2 move__delta"
                    >
                      {{ signed(m.newScore - m.oldScore) }}
                    </v-chip>
                  </div>
                </div>
                <div class="text-caption text-medium-emphasis mt-1">{{ moveReason(m.reason) }}, {{ when(m.computedAt) }}</div>
                <div v-if="m.components.length" class="d-flex flex-wrap ga-1 mt-2">
                  <v-chip
                    v-for="(c, j) in m.components"
                    :key="j"
                    size="x-small"
                    variant="outlined"
                    label
                    :title="c.detail"
                  >
                    {{ c.label }} <span class="ml-1 font-weight-bold move__delta">{{ signed(c.points) }}</span>
                  </v-chip>
                </div>
              </div>
            </template>
          </v-card>
        </v-col>

        <!-- Search adjustments -->
        <v-col cols="12" lg="4">
          <div class="section-label">Search changes</div>
          <v-card variant="outlined" class="pa-4">
            <template v-if="searchEmpty">
              <p class="text-body-2 text-medium-emphasis mb-0">
                Nothing yet. Rejecting a company, an industry, or the same title word three times makes search skip it.
                Sandbox rules never appear here.
              </p>
            </template>
            <template v-else>
              <div v-if="search!.excludedCompanies.length" class="mb-4">
                <div class="text-caption text-medium-emphasis mb-2">Skips these companies</div>
                <div class="d-flex flex-wrap ga-1">
                  <v-chip v-for="c in search!.excludedCompanies" :key="c" size="small" variant="tonal" color="error" label>{{ c }}</v-chip>
                </div>
              </div>
              <div v-if="search!.excludedKeywords.length" class="mb-4">
                <div class="text-caption text-medium-emphasis mb-2">Skips listings that mention</div>
                <div class="d-flex flex-wrap ga-1">
                  <v-chip v-for="k in search!.excludedKeywords" :key="k" size="small" variant="tonal" color="error" label>{{ k }}</v-chip>
                </div>
              </div>
              <div v-if="search!.boostKeywords.length">
                <div class="text-caption text-medium-emphasis mb-2">Also searches for</div>
                <div class="d-flex flex-wrap ga-1">
                  <v-chip v-for="k in search!.boostKeywords" :key="k" size="small" variant="tonal" color="success" label>{{ k }}</v-chip>
                </div>
              </div>
            </template>
          </v-card>
        </v-col>
      </v-row>
    </template>
  </div>
</template>

<style scoped lang="scss">
.learning-page {
  max-width: 1100px;

  &__note,
  &__lede {
    max-width: 680px;
    text-wrap: pretty;
  }

  &__num {
    font-variant-numeric: tabular-nums;
  }
}

.move {
  &__title {
    color: inherit;
    text-decoration: none;

    &:hover {
      text-decoration: underline;
    }
  }

  &__job {
    min-width: 0;
  }

  &__scores,
  &__delta {
    font-variant-numeric: tabular-nums;
  }
}
</style>

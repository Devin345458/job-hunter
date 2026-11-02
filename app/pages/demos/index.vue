<script setup lang="ts">
import type { DemoDetail } from '#shared/types/pipeline'
import { PIPELINE_SCHEDULE_TEXT } from '#shared/utils/schedule'

definePageMeta({ layout: 'default' })
useHead({ title: 'Demo projects' })

const snackbar = useSnackbar()
const demos = ref<DemoDetail[]>([])
const loading = ref(true)
const loadError = ref<string | null>(null)
const rebuilding = ref<number | null>(null)

/** Something is running on the server, so the list refreshes itself. */
const active = computed(() => demos.value.some(d => d.progress || d.preview.status === 'building'))

async function load(quiet = false) {
  if (!quiet) loading.value = true
  loadError.value = null
  try {
    const before = new Map(demos.value.map(d => [d.id, !!d.progress]))
    demos.value = (await $fetch<{ demos: DemoDetail[] }>('/api/demos')).demos
    for (const d of demos.value) {
      if (!before.get(d.id) || d.progress) continue
      if (d.status === 'built') snackbar.success(`${d.title} built. Tests pass.`)
      else if (d.status === 'failed') snackbar.warning(`${d.title} stopped. The card says why.`)
    }
  }
  catch (e: any) {
    if (!quiet) loadError.value = e?.data?.statusMessage || e?.message || 'Could not load demo projects'
  }
  finally {
    loading.value = false
    schedule()
  }
}

let timer: ReturnType<typeof setTimeout> | null = null
function schedule() {
  if (timer) clearTimeout(timer)
  timer = active.value ? setTimeout(() => load(true), 3000) : null
}

async function rebuild(demo: DemoDetail) {
  rebuilding.value = demo.id
  try {
    const updated = await $fetch<DemoDetail>(`/api/demos/${demo.id}/rebuild`, { method: 'POST' })
    demos.value = demos.value.map(d => d.id === demo.id ? { ...updated, buildLog: null, gap: null } : d)
    snackbar.info(`Building ${demo.title}. This card updates as it runs.`)
    schedule()
  }
  catch (e: any) {
    snackbar.error(e?.data?.statusMessage || 'Could not start the build')
  }
  finally {
    rebuilding.value = null
  }
}

onMounted(() => load())
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})
</script>

<template>
  <div class="demos-page fade-in">
    <div class="page-header">
      <h1 class="page-header__title text-h4">
        Demo projects
      </h1>
      <p class="page-header__subtitle text-body-1">
        Small projects built when a posting asks for something your record lacks. Each stays private until you approve its application.
      </p>
    </div>

    <v-alert v-if="loadError" type="error" variant="tonal" class="mb-4">
      {{ loadError }}
    </v-alert>

    <div v-if="loading" class="demos-page__grid">
      <v-skeleton-loader v-for="n in 2" :key="n" type="article" />
    </div>

    <div v-else-if="demos.length === 0 && !loadError" class="demos-page__empty">
      <v-icon icon="mdi-flask-empty-outline" size="44" class="mb-3 demos-page__empty-icon" />
      <p class="text-body-1 font-weight-medium mb-1">
        No demo projects yet
      </p>
      <p class="text-body-2 text-medium-emphasis">
        The pipeline builds one when a gap analysis recommends it. It runs {{ PIPELINE_SCHEDULE_TEXT }}.
      </p>
    </div>

    <div v-else class="demos-page__grid">
      <DemoCard
        v-for="d in demos"
        :key="d.id"
        :demo="d"
        :job-label="`${d.job.title} at ${d.job.company}`"
        :rebuilding="rebuilding === d.id"
        @rebuild="rebuild(d)"
      />
    </div>
  </div>
</template>

<style scoped lang="scss">
.demos-page {
  &__grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 380px), 1fr));
    gap: 16px;
  }

  &__empty {
    text-align: center;
    padding: 48px 16px;
  }

  &__empty-icon {
    opacity: 0.3;
  }
}
</style>

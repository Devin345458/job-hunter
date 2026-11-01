<script setup lang="ts">
import type { DemoDetail } from '#shared/types/pipeline'

definePageMeta({ layout: 'default' })
useHead({ title: 'Demo projects' })

const demos = ref<DemoDetail[]>([])
const loading = ref(true)
const loadError = ref<string | null>(null)

async function load() {
  loading.value = true
  loadError.value = null
  try {
    demos.value = (await $fetch<{ demos: DemoDetail[] }>('/api/demos')).demos
  }
  catch (e: any) {
    loadError.value = e?.data?.statusMessage || e?.message || 'Could not load demo projects'
  }
  finally {
    loading.value = false
  }
}

onMounted(load)
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
        The daily run builds one when a gap analysis recommends it.
      </p>
    </div>

    <div v-else class="demos-page__grid">
      <DemoCard
        v-for="d in demos"
        :key="d.id"
        :demo="d"
        :job-label="`${d.job.title} at ${d.job.company}`"
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

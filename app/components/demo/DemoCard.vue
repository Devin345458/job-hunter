<script setup lang="ts">
import type { DemoProjectView } from '#shared/types/pipeline'

// Summary of one demo project, for the review dashboard and the demos list.
const props = defineProps<{
  demo: DemoProjectView
  /** Shown under the title when the card is not already inside an application view. */
  jobLabel?: string | null
}>()

const testFacts = computed(() => {
  if (props.demo.testsPassed === true) return { icon: 'mdi-check-circle', color: 'success', text: 'Tests pass' }
  if (props.demo.testsPassed === false) return { icon: 'mdi-close-circle', color: 'error', text: 'Tests fail' }
  return null
})
</script>

<template>
  <v-card variant="outlined" class="demo-card">
    <v-card-item class="demo-card__head">
      <template #prepend>
        <v-avatar color="secondary" variant="tonal" size="40" rounded="lg">
          <v-icon icon="mdi-flask-outline" />
        </v-avatar>
      </template>
      <v-card-title class="demo-card__title">
        {{ demo.title }}
      </v-card-title>
      <v-card-subtitle class="demo-card__subtitle">
        <template v-if="jobLabel">{{ jobLabel }}</template>
        <template v-else-if="demo.gapAddressed">Shows: {{ demo.gapAddressed }}</template>
      </v-card-subtitle>
    </v-card-item>

    <v-card-text class="pt-1">
      <div class="mb-3">
        <DemoStatusChip :status="demo.status" />
      </div>
      <p v-if="jobLabel && demo.gapAddressed" class="demo-card__gap text-body-2 mb-2">
        Shows: {{ demo.gapAddressed }}
      </p>
      <p v-if="demo.summary" class="demo-card__summary text-body-2 mb-3">
        {{ demo.summary }}
      </p>
      <div v-if="demo.techStack.length" class="demo-card__stack mb-3">
        <v-chip v-for="t in demo.techStack" :key="t" size="small" variant="outlined">
          {{ t }}
        </v-chip>
      </div>
      <div class="demo-card__facts text-body-2">
        <span v-if="testFacts" class="demo-card__fact">
          <v-icon :icon="testFacts.icon" :color="testFacts.color" size="18" />
          {{ testFacts.text }}
        </span>
        <span v-if="demo.files.length" class="demo-card__fact">
          <v-icon icon="mdi-file-code-outline" size="18" />
          {{ demo.files.length }} files
        </span>
        <span v-if="demo.status === 'built'" class="demo-card__fact">
          <v-icon icon="mdi-lock-outline" size="18" />
          Publishes on approve
        </span>
      </div>
      <v-alert v-if="demo.status === 'failed' && demo.error" type="error" variant="tonal" density="compact" class="mt-3 text-body-2">
        {{ demo.error }}
      </v-alert>
    </v-card-text>

    <v-card-actions class="px-4 pb-4 pt-0 demo-card__actions">
      <v-btn variant="tonal" color="primary" :to="`/demos/${demo.id}`" prepend-icon="mdi-eye-outline">
        Open demo
      </v-btn>
      <v-btn v-if="demo.repoUrl && demo.repoUrl.startsWith('http')" variant="text" :href="demo.repoUrl" target="_blank" prepend-icon="mdi-open-in-new">
        Repository
      </v-btn>
    </v-card-actions>
  </v-card>
</template>

<style scoped lang="scss">
.demo-card {
  &__title {
    font-weight: 700;
    letter-spacing: -0.01em;
    white-space: normal;
    line-height: 1.3;
  }

  &__subtitle {
    white-space: normal;
  }

  &__gap,
  &__summary {
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    line-height: 1.6;
  }

  &__stack {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  &__facts {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 18px;
  }

  &__fact {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  &__actions {
    flex-wrap: wrap;
    gap: 8px;
  }
}
</style>

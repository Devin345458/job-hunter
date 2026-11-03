<script setup lang="ts">
import type { DemoDetail } from '#shared/types/pipeline'

// Summary of one demo project on the demos list: status, live build progress, why a build
// stopped, Build again, and a way into the preview.
const props = defineProps<{
  demo: DemoDetail
  /** Shown under the title when the card is not already inside an application view. */
  jobLabel?: string | null
  /** The Build again request is in flight. */
  rebuilding?: boolean
  /** The Discard request is in flight. */
  discarding?: boolean
}>()
const emit = defineEmits<{ rebuild: []; discard: [] }>()

/**
 * A demo the gap analysis no longer plans says "Discard it, or build it anyway", so the card
 * offers Discard beside Build again, behind the same confirm as the detail page.
 */
const canDiscard = computed(() => props.demo.noLongerPlanned && !props.demo.progress && ['proposed', 'built', 'failed'].includes(props.demo.status))
const discardOpen = ref(false)
watch(() => props.demo.status, (s) => {
  if (s === 'discarded') discardOpen.value = false
})

/** A build the server is running right now reads as building even before the row says so. */
const shownStatus = computed(() => props.demo.progress ? 'building' as const : props.demo.status)
const hasPreview = computed(() => ['built', 'published'].includes(props.demo.status) && props.demo.preview.kind !== 'none')

/**
 * What approving the application does with a built demo, from the same approveEffect the detail
 * page and the review card use: publish, publish and hand back for a by-hand submit, or nothing
 * while the GitHub token is missing.
 */
const publishFact = computed(() => {
  if (props.demo.status !== 'built') return null
  const effect = props.demo.approveEffect
  if (effect?.demoBlocked) return { icon: 'mdi-lock-alert-outline', tone: 'warning', text: 'Cannot be published: the GitHub token is not set' }
  if (effect?.submit === 'manual') return { icon: 'mdi-lock-outline', tone: null, text: 'Publishes on approve, then you submit by hand' }
  return { icon: 'mdi-lock-outline', tone: null, text: 'Publishes on approve' }
})

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
        <DemoStatusChip :status="shownStatus" :stopped="!!demo.stoppedFor" :not-needed="demo.noLongerPlanned" />
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
        <span v-if="publishFact" class="demo-card__fact" :class="publishFact.tone ? `text-${publishFact.tone}` : undefined">
          <v-icon :icon="publishFact.icon" size="18" />
          {{ publishFact.text }}
        </span>
      </div>
      <DemoBuildState :demo="demo" :busy="rebuilding" class="mt-3" @rebuild="emit('rebuild')" />
    </v-card-text>

    <v-card-actions class="px-4 pb-4 pt-0 demo-card__actions">
      <v-btn variant="tonal" color="primary" height="44" :to="`/demos/${demo.id}`" prepend-icon="mdi-file-eye-outline">
        Open demo
      </v-btn>
      <v-btn v-if="hasPreview" variant="tonal" height="44" :to="`/demos/${demo.id}#preview`" :prepend-icon="demo.preview.kind === 'web' ? 'mdi-monitor-eye' : 'mdi-test-tube'">
        {{ demo.preview.kind === 'web' ? 'Preview' : 'What it does' }}
      </v-btn>
      <v-btn v-if="demo.repoUrl && demo.repoUrl.startsWith('http')" variant="text" height="44" :href="demo.repoUrl" target="_blank" prepend-icon="mdi-open-in-new">
        Repository
      </v-btn>
      <v-btn v-if="canDiscard" variant="text" color="error" height="44" prepend-icon="mdi-delete-outline" class="demo-card__discard" @click="discardOpen = true">
        Discard
      </v-btn>
    </v-card-actions>

    <DemoDiscardDialog v-if="canDiscard" v-model="discardOpen" :loading="discarding" @confirm="emit('discard')" />
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

  &__discard {
    margin-inline-start: auto !important;
  }
}
</style>

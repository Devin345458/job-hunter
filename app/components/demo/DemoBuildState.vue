<script setup lang="ts">
import type { DemoDetail } from '#shared/types/pipeline'
import { DEMO_STOP_TEXT, plainError } from '#shared/utils/plain-text'
import { nextPipelineRunText } from '#shared/utils/schedule'

// The part of a demo that changes while it builds: live progress, why the last build stopped,
// and the Build again button with its cost. Shared by the demos list card and the detail page.
const props = defineProps<{ demo: DemoDetail; busy?: boolean }>()
const emit = defineEmits<{ rebuild: [] }>()

const running = computed(() => props.demo.progress)
const lastLine = computed(() => running.value?.recent.at(-1)?.trim() || null)
/** A row left in building by a server restart: nothing is running it. */
const interrupted = computed(() => !running.value && props.demo.status === 'building')
const canBuild = computed(() => !running.value && (props.demo.status === 'failed' || props.demo.status === 'proposed' || interrupted.value))
const label = computed(() => {
  if (props.demo.status === 'proposed') return 'Build now'
  return props.demo.stoppedFor ? 'Build again now' : 'Build again'
})

function elapsed(startedAt: string) {
  const min = Math.floor((Date.now() - Date.parse(startedAt)) / 60_000)
  return min < 1 ? 'under a minute' : `${min} min`
}
</script>

<template>
  <div class="demo-build-state">
    <div v-if="running" class="demo-build-state__running" role="status" aria-live="polite">
      <div class="demo-build-state__running-head text-body-2">
        <v-progress-circular indeterminate size="16" width="2" color="info" />
        <span class="font-weight-medium">{{ running.phase === 'preview' ? 'Tests pass. Building the preview' : 'Building with Claude' }}</span>
        <span v-if="running.phase === 'build' && running.maxTurns" class="text-medium-emphasis">Turn {{ running.turn }} of {{ running.maxTurns }}</span>
        <span class="text-medium-emphasis">{{ elapsed(running.startedAt) }}</span>
      </div>
      <v-progress-linear
        v-if="running.phase === 'build' && running.maxTurns"
        :model-value="Math.max(2, (running.turn / running.maxTurns) * 100)"
        color="info"
        height="4"
        class="my-2"
        aria-label="Build turns used"
      />
      <p v-if="lastLine" class="demo-build-state__line text-caption">
        {{ lastLine }}
      </p>
    </div>

    <template v-else>
      <v-alert v-if="interrupted" type="warning" variant="tonal" density="compact" class="text-body-2 mb-3">
        This build is not running anymore. The server restarted while it ran.
      </v-alert>
      <v-alert
        v-else-if="demo.status === 'failed' && demo.stoppedFor"
        type="warning"
        variant="tonal"
        density="compact"
        icon="mdi-pause-circle-outline"
        class="text-body-2 mb-3"
      >
        <div class="font-weight-bold">
          {{ DEMO_STOP_TEXT[demo.stoppedFor] }}
        </div>
        <div>
          The build itself did not fail. The next pipeline run, at {{ nextPipelineRunText() }} Central, retries it automatically.
        </div>
      </v-alert>
      <v-alert v-else-if="demo.status === 'failed' && demo.error" type="error" variant="tonal" density="compact" class="text-body-2 mb-3 demo-build-state__wrap">
        {{ plainError(demo.error) }}
      </v-alert>

      <div v-if="canBuild" class="demo-build-state__action">
        <v-btn variant="tonal" height="44" prepend-icon="mdi-hammer-wrench" :loading="busy" @click="emit('rebuild')">
          {{ label }}
        </v-btn>
        <span class="text-caption text-medium-emphasis">Uses Claude. A build has cost about $0.50 to $1.</span>
      </div>
    </template>
  </div>
</template>

<style scoped lang="scss">
.demo-build-state {
  &__running {
    padding: 12px 14px;
    border-radius: 8px;
    background: rgba(var(--v-theme-info), 0.08);
    border: 1px solid rgba(var(--v-theme-info), 0.24);
  }

  &__running-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 10px;
  }

  &__line {
    margin: 0;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  &__wrap {
    overflow-wrap: anywhere;
  }

  &__action {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
  }
}
</style>

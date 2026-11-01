<script setup lang="ts">
import type { DemoStatus } from '#shared/types/pipeline'

const props = withDefaults(defineProps<{ status: DemoStatus; size?: string }>(), { size: 'small' })

const META: Record<DemoStatus, { label: string; color: string; icon: string }> = {
  proposed: { label: 'Planned', color: 'grey', icon: 'mdi-lightbulb-outline' },
  building: { label: 'Building', color: 'info', icon: 'mdi-hammer-wrench' },
  built: { label: 'Built, not published', color: 'success', icon: 'mdi-check-circle-outline' },
  failed: { label: 'Build failed', color: 'error', icon: 'mdi-alert-circle-outline' },
  publishing: { label: 'Publishing', color: 'warning', icon: 'mdi-upload-outline' },
  published: { label: 'Published', color: 'primary', icon: 'mdi-earth' },
  discarded: { label: 'Discarded', color: 'grey', icon: 'mdi-delete-outline' },
}

const meta = computed(() => META[props.status] ?? { label: props.status, color: 'grey', icon: 'mdi-help-circle-outline' })
</script>

<template>
  <v-chip :color="meta.color" variant="tonal" :size="size" :prepend-icon="meta.icon" class="demo-status-chip">
    {{ meta.label }}
  </v-chip>
</template>

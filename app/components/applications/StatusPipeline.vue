<script setup lang="ts">
export interface PipelineCounts {
  draft: number
  ready: number
  submitted: number
  response_received: number
  interviewing: number
  rejected: number
  offer: number
}

const props = withDefaults(defineProps<{
  counts: PipelineCounts
}>(), {
  counts: () => ({
    draft: 0,
    ready: 0,
    submitted: 0,
    response_received: 0,
    interviewing: 0,
    rejected: 0,
    offer: 0,
  }),
})

interface PipelineStage {
  key: keyof PipelineCounts
  label: string
  color: string
  icon: string
}

const stages: PipelineStage[] = [
  { key: 'draft', label: 'Draft', color: 'grey', icon: 'mdi-pencil-outline' },
  { key: 'ready', label: 'Ready', color: 'info', icon: 'mdi-check-circle-outline' },
  { key: 'submitted', label: 'Submitted', color: 'primary', icon: 'mdi-send' },
  { key: 'response_received', label: 'Response', color: 'accent', icon: 'mdi-email-open' },
  { key: 'interviewing', label: 'Interview', color: 'warning', icon: 'mdi-account-voice' },
  { key: 'rejected', label: 'Rejected', color: 'error', icon: 'mdi-close-circle-outline' },
  { key: 'offer', label: 'Offer', color: 'success', icon: 'mdi-party-popper' },
]

const totalActive = computed(() =>
  Object.values(props.counts).reduce((sum, c) => sum + c, 0),
)
</script>

<template>
  <v-card variant="outlined">
    <v-card-text>
      <div class="d-flex align-center justify-space-between mb-2">
        <span class="text-subtitle-2">Application Pipeline</span>
        <span class="text-caption text-medium-emphasis">{{ totalActive }} total</span>
      </div>

      <div class="pipeline">
        <div
          v-for="(stage, index) in stages"
          :key="stage.key"
          class="pipeline__stage"
        >
          <v-chip
            :color="stage.color"
            :variant="props.counts[stage.key] > 0 ? 'flat' : 'outlined'"
            :prepend-icon="stage.icon"
            class="pipeline__chip"
          >
            {{ stage.label }}
            <template #append>
              <span class="font-weight-bold ml-1">{{ props.counts[stage.key] }}</span>
            </template>
          </v-chip>

          <v-icon
            v-if="index < stages.length - 1"
            size="x-small"
            icon="mdi-chevron-right"
            class="pipeline__arrow text-medium-emphasis"
          />
        </div>
      </div>
    </v-card-text>
  </v-card>
</template>

<style scoped lang="scss">
.pipeline {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;

  &__stage {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  &__chip {
    min-width: 80px;
    justify-content: center;
  }

  &__arrow {
    flex-shrink: 0;
  }
}
</style>

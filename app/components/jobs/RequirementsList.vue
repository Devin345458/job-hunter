<script setup lang="ts">
import type { Requirement } from '#shared/types/pipeline'
import { plainKnowledgeRefs } from '#shared/utils/plain-text'

const props = defineProps<{
  requirements: Requirement[]
}>()

const STATUS = {
  have: { label: 'Have', color: 'success', icon: 'mdi-check-circle-outline' },
  partial: { label: 'Partial', color: 'warning', icon: 'mdi-circle-half-full' },
  lack: { label: 'Lack', color: 'error', icon: 'mdi-close-circle-outline' },
  unknown: { label: 'Not in profile', color: 'grey', icon: 'mdi-help-circle-outline' },
} as const

const mustHave = computed(() => props.requirements.filter(r => r.mustHave))
const niceToHave = computed(() => props.requirements.filter(r => !r.mustHave))
const counts = computed(() => {
  const out = { have: 0, partial: 0, lack: 0, unknown: 0 }
  for (const r of mustHave.value) out[r.status]++
  return out
})
</script>

<template>
  <v-card variant="outlined" class="requirements">
    <v-card-item>
      <v-card-title class="text-subtitle-1 font-weight-medium">
        Requirements
      </v-card-title>
      <v-card-subtitle v-if="mustHave.length" class="text-caption requirements__subtitle">
        Must-haves: {{ counts.have }} have, {{ counts.partial }} partial, {{ counts.lack }} lack, {{ counts.unknown }} not in your profile
      </v-card-subtitle>
    </v-card-item>
    <v-card-text>
      <template v-for="group in [{ title: 'Must have', items: mustHave }, { title: 'Nice to have', items: niceToHave }]" :key="group.title">
        <div v-if="group.items.length" class="requirements__group">
          <div class="text-body-2 font-weight-medium mb-2">
            {{ group.title }}
          </div>
          <div v-for="(r, i) in group.items" :key="i" class="requirements__item">
            <v-icon :icon="STATUS[r.status].icon" :color="STATUS[r.status].color" size="18" class="requirements__icon" />
            <div class="requirements__body">
              <div class="text-body-2">
                {{ r.text }}
              </div>
              <div class="text-caption text-medium-emphasis">
                {{ STATUS[r.status].label }}{{ r.evidence ? `, from ${plainKnowledgeRefs(r.evidence)}` : '' }}
              </div>
            </div>
          </div>
        </div>
      </template>
      <p class="text-caption text-medium-emphasis mt-2">
        Judged only against your knowledge base. "Not in profile" means it does not say either way.
      </p>
    </v-card-text>
  </v-card>
</template>

<style scoped lang="scss">
.requirements {
  &__subtitle {
    white-space: normal;
  }

  &__group + &__group {
    margin-top: 16px;
  }

  &__item {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 6px 0;
  }

  &__icon {
    margin-top: 2px;
    flex-shrink: 0;
  }

  &__body {
    min-width: 0;
    overflow-wrap: anywhere;
  }
}
</style>

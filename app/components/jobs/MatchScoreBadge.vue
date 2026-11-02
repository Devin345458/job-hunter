<script setup lang="ts">
const props = withDefaults(defineProps<{
  score: number
  size?: 'small' | 'default' | 'large'
}>(), {
  size: 'default',
})

const color = computed(() => {
  if (props.score >= 80) return 'success'
  if (props.score >= 60) return 'warning'
  return 'error'
})

const dimensions = computed(() => {
  switch (props.size) {
    case 'small': return { width: 36, fontSize: '0.75rem' }
    case 'large': return { width: 56, fontSize: '1.125rem' }
    default: return { width: 44, fontSize: '0.875rem' }
  }
})
</script>

<template>
  <!-- The ring is named for screen readers; title gives the same words on hover. A Vuetify tooltip
       here left an empty tooltip node on every card, which has no accessible name. -->
  <div
    class="match-score-badge"
    :title="`Match score ${score} out of 100`"
    :style="{
      width: `${dimensions.width}px`,
      height: `${dimensions.width}px`,
      fontSize: dimensions.fontSize,
    }"
  >
    <v-progress-circular
      :model-value="score"
      :size="dimensions.width"
      :width="3"
      :color="color"
      :aria-label="`Match score ${score} out of 100`"
    >
      <span class="font-weight-bold" aria-hidden="true">{{ score }}</span>
    </v-progress-circular>
  </div>
</template>

<style scoped lang="scss">
.match-score-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
</style>

<script setup lang="ts">
import type { LearnedRuleView } from '#shared/types/learning'

// One learned rule on /learning: what it does to a score (or to search), the plain sentence
// saying why, how much evidence it rests on, and Devin's switch.

const props = defineProps<{
  rule: LearnedRuleView
  busy?: boolean
}>()

const emit = defineEmits<{ toggle: [active: boolean] }>()

const MAX_DOTS = 10

const isScore = computed(() => props.rule.effect === 'score')
const effectColor = computed(() => {
  if (!isScore.value) return props.rule.effect === 'exclude_search' ? 'error' : 'success'
  return props.rule.weight < 0 ? 'error' : 'success'
})
const effectText = computed(() => (props.rule.weight > 0 ? `+${props.rule.weight}` : `${props.rule.weight}`))
const dots = computed(() => Math.min(props.rule.evidenceCount, MAX_DOTS))
const extra = computed(() => Math.max(0, props.rule.evidenceCount - MAX_DOTS))
</script>

<template>
  <div class="rule-row d-flex align-start ga-3 ga-sm-4 pa-4" :class="{ 'rule-row--off': !rule.active }">
    <div class="rule-row__effect text-center" :class="`text-${effectColor}`">
      <template v-if="isScore">
        <div class="rule-row__points">{{ effectText }}</div>
        <div class="rule-row__unit">points</div>
      </template>
      <template v-else>
        <v-icon :icon="rule.effect === 'exclude_search' ? 'mdi-magnify-close' : 'mdi-magnify-plus'" size="26" />
        <div class="rule-row__unit">search</div>
      </template>
    </div>

    <div class="rule-row__body flex-grow-1">
      <p class="rule-row__sentence text-body-2 mb-2">{{ rule.explanation }}</p>
      <div class="d-flex flex-wrap align-center ga-2 text-caption text-medium-emphasis">
        <span class="rule-row__dots" :aria-label="`${rule.evidenceCount} decisions`">
          <span v-for="n in dots" :key="n" class="rule-row__dot" />
          <span v-if="extra" class="ml-1">+{{ extra }}</span>
        </span>
        <span>{{ rule.evidenceCount }} {{ rule.evidenceCount === 1 ? 'decision' : 'decisions' }}</span>
        <span v-if="isScore">Matches {{ rule.matchingOpenJobs }} open {{ rule.matchingOpenJobs === 1 ? 'job' : 'jobs' }}</span>
        <v-chip v-if="!rule.active" size="x-small" variant="tonal" label>Off</v-chip>
      </div>
    </div>

    <v-switch
      :model-value="rule.active"
      :disabled="busy"
      :loading="busy ? 'primary' : false"
      color="primary"
      inset
      hide-details
      density="compact"
      class="rule-row__switch flex-grow-0 flex-shrink-0"
      :aria-label="rule.active ? 'Turn this rule off' : 'Turn this rule on'"
      @update:model-value="v => emit('toggle', !!v)"
    />
  </div>
</template>

<style scoped lang="scss">
.rule-row {
  transition: opacity 0.15s ease;

  &--off {
    .rule-row__effect,
    .rule-row__sentence {
      opacity: 0.45;
    }
  }

  &__effect {
    flex: 0 0 56px;
    padding-top: 2px;
  }

  &__points {
    font-size: 1.5rem;
    font-weight: 700;
    line-height: 1.1;
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
  }

  &__unit {
    font-size: 0.6875rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    opacity: 0.7;
  }

  &__body {
    min-width: 0;
  }

  &__sentence {
    line-height: 1.5;
    text-wrap: pretty;
  }

  &__dots {
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }

  &__dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: rgb(var(--v-theme-primary));
  }

  // The inset track is 52px wide; a shrinkable flex item squeezes the input to 17px and the
  // track spills past the card edge on a phone.
  &__switch {
    flex: 0 0 auto;
    margin-top: -6px;
  }
}
</style>

<script setup lang="ts">
import type { ScoreBreakdown } from '#shared/types/pipeline'
import { scoreColor } from '~/components/jobs/format'

// The match score as an itemized ledger: what the skills and pay fits put in, then every
// learned adjustment as its own line with the reason it exists. The bar above the lines draws
// the same arithmetic so a glance shows how much of the score is learned.
const props = defineProps<{
  score: ScoreBreakdown
  /** Desktop review card: leaves out the Base score line when no learned adjustment changes it. */
  dense?: boolean
}>()

// The verdict reads in ink: the score's own hue carries the measure, and a weak match is not an error.
const RECOMMENDATION: Record<ScoreBreakdown['recommendation'], { label: string; color: string }> = {
  strong_match: { label: 'Strong match', color: 'success' },
  good_match: { label: 'Good match', color: 'primary' },
  partial_match: { label: 'Partial match', color: 'warning' },
  weak_match: { label: 'Weak match', color: 'error' },
}

const rec = computed(() => RECOMMENDATION[props.score.recommendation] ?? RECOMMENDATION.partial_match)
/** The score's band color (green 80 and up, amber 60 to 79, red under 60), on the total and the bar. */
const band = computed(() => scoreColor(props.score.final))
const learned = computed(() => props.score.learned?.components ?? [])
const learnedTotal = computed(() => props.score.learned?.total ?? 0)
const base = computed(() => Math.max(0, Math.min(100, props.score.final - learnedTotal.value)))
const plus = computed(() => learned.value.filter(c => c.points > 0).reduce((n, c) => n + c.points, 0))
const minus = computed(() => learned.value.filter(c => c.points < 0).reduce((n, c) => n - c.points, 0))

// Bar geometry in percent of 100 points.
const barBase = computed(() => Math.max(0, base.value - minus.value))
const barMinus = computed(() => Math.min(minus.value, base.value))
const barPlus = computed(() => Math.min(plus.value, 100 - base.value))

function signed(n: number) {
  return n > 0 ? `+${n}` : `${n}`
}
function pct(w: number) {
  return `${Math.round(w * 100)}%`
}
</script>

<template>
  <div class="ledger">
    <div class="ledger__head">
      <div class="ledger__total tabular" :class="`text-${band}`" :aria-label="`Match score ${score.final} out of 100`">{{ score.final }}</div>
      <div class="ledger__verdict">
        <div class="ledger__rec" :class="`text-${rec.color}`">
          <span class="ledger__dot" :class="`bg-${rec.color}`" />
          {{ rec.label }}
        </div>
        <div class="ledger__of">match score, out of 100</div>
      </div>
    </div>

    <div class="ledger__bar" role="img" :aria-label="`Base ${base}, learned ${signed(learnedTotal)}`">
      <span class="ledger__seg ledger__seg--base" :class="`bg-${band}`" :style="{ width: `${barBase}%` }" />
      <span v-if="barMinus > 0" class="ledger__seg ledger__seg--minus" :style="{ width: `${barMinus}%` }" />
      <span v-if="barPlus > 0" class="ledger__seg ledger__seg--plus" :style="{ width: `${barPlus}%` }" />
    </div>

    <!-- The card's phone summary (matched and missing skills, pay) sits right under the score. -->
    <slot name="summary" />

    <dl class="ledger__lines">
      <div class="ledger__line">
        <dt>Skills fit <span class="ledger__weight">weighted {{ pct(score.weights.skills) }}</span></dt>
        <dd class="tabular">{{ score.skills.score }}</dd>
      </div>
      <div class="ledger__line">
        <dt>
          Pay fit <span class="ledger__weight">weighted {{ pct(score.weights.compensation) }}</span>
        </dt>
        <dd class="tabular">
          <template v-if="score.compensation.score !== null">{{ score.compensation.score }}</template>
          <span v-else class="ledger__na">not stated</span>
        </dd>
      </div>
      <div v-if="!dense || learned.length" class="ledger__line ledger__line--sub">
        <dt>Base score</dt>
        <dd class="tabular">{{ base }}</dd>
      </div>
      <div v-for="(c, i) in learned" :key="i" class="ledger__line ledger__line--learned">
        <dt>
          <span class="ledger__learned-label">{{ c.label }}</span>
          <span class="ledger__why">{{ c.detail }}</span>
        </dt>
        <dd class="tabular" :class="c.points >= 0 ? 'text-success' : 'text-error'">{{ signed(c.points) }}</dd>
      </div>
      <div v-if="learned.length === 0" class="ledger__line ledger__line--learned">
        <dt><span class="ledger__why">No learned adjustments apply to this job yet.</span></dt>
        <dd />
      </div>
    </dl>
  </div>
</template>

<style scoped lang="scss">
.ledger {
  &__head {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 12px;
  }

  // The answer figure: the largest number on the card, in the one data hue.
  &__total {
    font-size: 2.25rem;
    line-height: 1;
    font-weight: 600;
    letter-spacing: -0.02em;
  }

  &__rec {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
    font-size: 0.9375rem;
  }

  &__dot {
    width: 8px;
    height: 8px;
    border-radius: 2px;
  }

  &__of {
    font-size: 0.75rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__bar {
    display: flex;
    height: 6px;
    border-radius: 3px;
    overflow: hidden;
    background: rgb(var(--v-theme-surface-light));
    margin-bottom: 12px;
  }

  &__seg {
    height: 100%;

    // Points learning took off: the negative color, flat and dimmer than a fill, so it reads as removed.
    &--minus { background: rgba(var(--v-theme-error), 0.55); }
    &--plus { background: rgb(var(--v-theme-success)); }
  }

  &__lines {
    margin: 0;
  }

  &__line {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 5px 0;
    font-size: 0.875rem;

    dt { min-width: 0; }

    dd {
      margin: 0;
      font-weight: 600;
      flex-shrink: 0;
    }

    &--sub {
      border-top: 1px solid rgb(var(--v-theme-surface-light));
      margin-top: 2px;
      padding-top: 7px;
      color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    }

    &--learned dt {
      display: flex;
      flex-direction: column;
      gap: 1px;
    }
  }

  &__weight {
    font-size: 0.75rem;
    margin-left: 4px;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__na {
    font-weight: 400;
    font-size: 0.8125rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__learned-label {
    font-weight: 500;
  }

  &__why {
    font-size: 0.75rem;
    line-height: 1.45;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }
}
</style>

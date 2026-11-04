<script setup lang="ts">
import type { CompensationBreakdown, ScoreBreakdown } from '#shared/types/pipeline'
import { money, moneyRange } from '~/composables/review/format'
import { payExtraText, payFiguresInText } from '#shared/utils/pay-format'
import { plainQuestionRefs, secondPerson } from '#shared/utils/plain-text'

// Total compensation against Devin's floor. The scale draws base pay as a solid band, the
// rest of the total estimate as a lighter extension, and the floor as a vertical rule, so
// "does this clear my number" is answered before any figure is read.
const props = defineProps<{
  comp: CompensationBreakdown | null
  score: ScoreBreakdown | null
  /** Listing salary, used when the posting itself was never parsed. */
  listing?: { min: number | null; max: number | null; currency: string | null }
  /** Compact: the scale and headline only, no breakdown lines. */
  compact?: boolean
  /** Inline: one line, "Pay $164k to $235k total · No floor set", for the phone summary under the score. */
  inline?: boolean
  /** Desktop review card: with compact, leaves out the scale when no floor is set (there is nothing to clear) and tightens the lines. */
  dense?: boolean
}>()

const currency = computed(() => props.comp?.currency || props.listing?.currency || 'USD')
const floor = computed(() => props.score?.compensation.floor ?? null)
const baseMin = computed(() => props.comp?.baseAnnualMin ?? props.listing?.min ?? null)
const baseMax = computed(() => props.comp?.baseAnnualMax ?? props.listing?.max ?? null)
const totalMin = computed(() => props.comp?.totalEstimateMin ?? null)
const totalMax = computed(() => props.comp?.totalEstimateMax ?? null)
const hasFigures = computed(() => baseMin.value !== null || baseMax.value !== null || totalMin.value !== null)

const meetsFloor = computed<boolean | null>(() => {
  if (props.score?.compensation.meetsFloor !== undefined && props.score?.compensation.meetsFloor !== null) return props.score.compensation.meetsFloor
  if (floor.value === null) return null
  const top = totalMax.value ?? baseMax.value ?? baseMin.value
  return top === null ? null : top >= floor.value
})

const headline = computed(() => {
  if (totalMin.value !== null || totalMax.value !== null) return moneyRange(totalMin.value, totalMax.value, currency.value)
  if (hasFigures.value) return moneyRange(baseMin.value, baseMax.value, currency.value)
  return 'Pay not stated'
})
const headlineLabel = computed(() => {
  if (totalMin.value !== null || totalMax.value !== null) return 'estimated total per year'
  if (hasFigures.value) return 'base per year'
  return props.comp?.confidence === 'partial' ? 'some benefits stated, no figures' : 'the posting gives no pay figures'
})

/** The headline's kind in one word, for the inline line. */
const inlineKind = computed(() => {
  if (totalMin.value !== null || totalMax.value !== null) return 'total'
  return hasFigures.value ? 'base' : ''
})

const verdict = computed(() => {
  if (floor.value === null) return { text: 'No floor set', tone: 'muted' }
  if (meetsFloor.value === true) {
    const low = baseMin.value ?? totalMin.value
    return low !== null && low >= floor.value
      ? { text: `Clears your ${money(floor.value)} floor`, tone: 'success' }
      : { text: `Top of range clears your ${money(floor.value)} floor`, tone: 'success' }
  }
  if (meetsFloor.value === false) return { text: `Below your ${money(floor.value)} floor`, tone: 'error' }
  return { text: `Unknown against your ${money(floor.value)} floor`, tone: 'muted' }
})

// Scale geometry: 0 to a round number above everything shown.
const scaleMax = computed(() => {
  const top = Math.max(floor.value ?? 0, baseMax.value ?? 0, totalMax.value ?? 0, baseMin.value ?? 0, totalMin.value ?? 0)
  return Math.max(50000, Math.ceil((top * 1.12) / 50000) * 50000)
})
function at(n: number) {
  return `${Math.max(0, Math.min(100, (n / scaleMax.value) * 100))}%`
}
const baseBand = computed(() => {
  const lo = baseMin.value ?? baseMax.value
  const hi = baseMax.value ?? baseMin.value
  return lo === null || hi === null ? null : { left: at(lo), width: `calc(${at(hi)} - ${at(lo)} + 3px)` }
})
const totalBand = computed(() => {
  const lo = totalMin.value ?? baseMin.value
  const hi = totalMax.value
  return lo === null || hi === null ? null : { left: at(lo), width: `calc(${at(hi)} - ${at(lo)} + 3px)` }
})

const benefits = computed(() => props.comp?.benefits ?? [])
const CONFIDENCE: Record<CompensationBreakdown['confidence'], string> = {
  stated: 'Salary stated in the posting',
  partial: 'Some pay details stated',
  not_stated: 'No pay details in the posting',
}
</script>

<template>
  <p v-if="inline" class="comp-inline">
    <span class="comp-inline__label">Pay</span>
    <span>{{ headline }}{{ inlineKind ? ` ${inlineKind}` : '' }}</span>
    <span class="comp-inline__sep" aria-hidden="true">·</span>
    <span :class="`comp-inline__tone--${verdict.tone}`">{{ verdict.text }}</span>
  </p>
  <div v-else class="comp">
    <div class="comp__head">
      <div>
        <div class="comp__figure">{{ headline }}</div>
        <div class="comp__label">{{ headlineLabel }}</div>
      </div>
      <div class="comp__verdict" :class="`comp__verdict--${verdict.tone}`">
        <v-icon
          :icon="verdict.tone === 'success' ? 'mdi-arrow-up-bold-box-outline' : verdict.tone === 'error' ? 'mdi-arrow-down-bold-box-outline' : 'mdi-help-box-outline'"
          size="16"
        />
        {{ verdict.text }}
      </div>
    </div>

    <!-- No pay figures and no floor: an empty $0 to $50k track would say nothing. -->
    <div v-if="(hasFigures || floor !== null) && !(dense && compact && floor === null)" class="comp__scale" aria-hidden="true">
      <div class="comp__track" />
      <div v-if="totalBand" class="comp__band comp__band--total" :style="totalBand" />
      <div v-if="baseBand" class="comp__band comp__band--base" :style="baseBand" />
      <div v-if="floor !== null" class="comp__floor" :style="{ left: at(floor) }">
        <span class="comp__floor-label">floor {{ money(floor) }}</span>
      </div>
      <div class="comp__ticks">
        <span>{{ money(0) }}</span>
        <span>{{ money(scaleMax) }}</span>
      </div>
    </div>

    <dl v-if="compact" class="comp__brief" :class="{ 'comp__brief--dense': dense }">
      <div><dt>Base</dt><dd>{{ hasFigures ? moneyRange(baseMin, baseMax, currency) : 'Not stated' }}</dd></div>
      <div><dt>Bonus</dt><dd>{{ payExtraText(comp?.bonus, currency) }}</dd></div>
      <div><dt>Equity</dt><dd>{{ payExtraText(comp?.equity, currency) }}</dd></div>
      <div><dt>Benefits</dt><dd>{{ benefits.length ? `${benefits.length} quoted from the posting` : 'Not stated' }}</dd></div>
    </dl>

    <template v-if="!compact">
      <dl class="comp__lines">
        <div class="comp__line">
          <dt>Base salary</dt>
          <dd>{{ hasFigures ? moneyRange(baseMin, baseMax, currency) : 'Not stated' }}</dd>
        </div>
        <div class="comp__line">
          <dt>Bonus</dt>
          <dd>
            <template v-if="comp?.bonus">
              <span>{{ payExtraText(comp.bonus, currency) }}</span>
              <span class="comp__desc">{{ comp.bonus.description }}</span>
              <q class="comp__quote">{{ comp.bonus.quote }}</q>
            </template>
            <template v-else>Not stated</template>
          </dd>
        </div>
        <div class="comp__line">
          <dt>Equity</dt>
          <dd>
            <template v-if="comp?.equity">
              <span>{{ payExtraText(comp.equity, currency) }}</span>
              <span class="comp__desc">{{ comp.equity.description }}</span>
              <q class="comp__quote">{{ comp.equity.quote }}</q>
            </template>
            <template v-else>Not stated</template>
          </dd>
        </div>
        <div class="comp__line comp__line--stack">
          <dt>Benefits <span class="comp__count">{{ benefits.length || 'none stated' }}</span></dt>
          <dd>
            <ul v-if="benefits.length" class="comp__benefits">
              <li v-for="(b, i) in benefits" :key="i">
                <div class="comp__benefit-row">
                  <span class="comp__benefit-name">{{ b.name }}</span>
                  <span class="comp__benefit-value">{{ b.estimatedAnnualValue !== null ? `${money(b.estimatedAnnualValue, currency)}/yr` : 'not valued' }}</span>
                </div>
                <span v-if="b.detail" class="comp__desc">{{ b.detail }}</span>
                <q class="comp__quote">{{ b.quote }}</q>
              </li>
            </ul>
          </dd>
        </div>
      </dl>
      <p v-if="comp?.notes || score?.compensation.reasoning" class="comp__notes">
        <span v-if="comp">{{ CONFIDENCE[comp.confidence] }}. </span>{{ secondPerson(plainQuestionRefs(payFiguresInText(score?.compensation.reasoning))) }} {{ secondPerson(plainQuestionRefs(payFiguresInText(comp?.notes))) }}
      </p>
    </template>
  </div>
</template>

<style scoped lang="scss">
.comp-inline {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 6px;
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.45;

  &__label {
    font-weight: 600;
  }

  &__sep,
  &__tone--muted {
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__tone--success { color: rgb(var(--v-theme-success)); }
  &__tone--error { color: rgb(var(--v-theme-error)); }
}

.comp {
  &__head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px 16px;
    margin-bottom: 14px;
  }

  &__figure {
    font-size: 1.375rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: 1.2;
  }

  &__label {
    font-size: 0.75rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__verdict {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 0.8125rem;
    font-weight: 600;
    padding: 4px 8px;
    border-radius: 6px;

    &--success { color: rgb(var(--v-theme-success)); background: rgba(var(--v-theme-success), 0.1); }
    &--error { color: rgb(var(--v-theme-error)); background: rgba(var(--v-theme-error), 0.1); }
    &--muted { color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); background: rgba(var(--v-theme-on-surface), 0.06); }
  }

  &__scale {
    position: relative;
    height: 44px;
    margin: 0 2px 6px;
  }

  &__track {
    position: absolute;
    left: 0;
    right: 0;
    top: 18px;
    height: 8px;
    border-radius: 2px;
    background: rgba(var(--v-theme-on-surface), 0.07);
  }

  &__band {
    position: absolute;
    top: 18px;
    height: 8px;
    border-radius: 2px;

    &--total { background: rgba(var(--v-theme-primary), 0.35); }
    &--base { background: rgb(var(--v-theme-primary)); }
  }

  &__floor {
    position: absolute;
    top: 12px;
    width: 2px;
    height: 20px;
    margin-left: -1px;
    background: rgb(var(--v-theme-on-surface));
  }

  &__floor-label {
    position: absolute;
    top: -14px;
    left: 50%;
    transform: translateX(-50%);
    white-space: nowrap;
    font-size: 0.75rem;
    font-weight: 600;
  }

  &__ticks {
    position: absolute;
    left: 0;
    right: 0;
    top: 30px;
    display: flex;
    justify-content: space-between;
    font-size: 0.75rem;
    color: rgba(var(--v-theme-on-surface), var(--v-disabled-opacity));
  }

  &__lines {
    margin: 12px 0 0;
  }

  &__brief {
    margin: 10px 0 0;

    &--dense div {
      padding: 3px 0 !important;
    }

    div {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 5px 0;
      font-size: 0.8125rem;
      border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    }

    dt {
      color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    }

    dd {
      margin: 0;
      text-align: right;
    }
  }

  &__line {
    display: grid;
    grid-template-columns: 96px 1fr;
    gap: 12px;
    padding: 8px 0;
    border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    font-size: 0.875rem;

    dt {
      color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    }

    dd {
      margin: 0;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
  }

  &__count {
    display: block;
    font-size: 0.75rem;
  }

  &__desc {
    font-size: 0.8125rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__quote {
    display: block;
    margin-top: 2px;
    padding-left: 10px;
    border-left: 2px solid rgba(var(--v-theme-primary), 0.5);
    font-size: 0.8125rem;
    line-height: 1.5;
    color: rgba(var(--v-theme-on-surface), 0.8);
    quotes: '\201C' '\201D';
  }

  &__benefits {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  &__benefit-row {
    display: flex;
    justify-content: space-between;
    gap: 8px;
  }

  &__benefit-name {
    font-weight: 500;
  }

  &__benefit-value {
    flex-shrink: 0;
    font-size: 0.8125rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__notes {
    margin: 10px 0 0;
    font-size: 0.8125rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }
}

@media (max-width: 599.98px) {
  .comp__line {
    grid-template-columns: 1fr;
    gap: 4px;
  }
}
</style>

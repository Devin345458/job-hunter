<script setup lang="ts">
import type { CompensationBreakdown } from '#shared/types/pipeline'
import { PIPELINE_SCHEDULE_TEXT } from '#shared/utils/schedule'
import { formatMoney, formatRange } from './format'
import { payExtraText, payFiguresInText } from '#shared/utils/pay-format'
import { benefitPart, compParts, partAmount, partPercent, totalSourcesText, type CompPart } from '#shared/utils/comp-parts'

const props = defineProps<{
  compensation: CompensationBreakdown | null
  enrichedAt?: string | null
}>()

const CONFIDENCE = {
  stated: { label: 'Pay stated', color: 'success' },
  partial: { label: 'Partly stated', color: 'warning' },
  not_stated: { label: 'No pay stated', color: 'grey' },
} as const

const BENEFIT_LABELS: Record<string, string> = {
  health: 'Health',
  dental_vision: 'Dental and vision',
  retirement: 'Retirement',
  pto: 'Time off',
  parental: 'Parental',
  learning: 'Learning',
  equipment: 'Equipment',
  wellness: 'Wellness',
  remote_stipend: 'Remote stipend',
  insurance: 'Insurance',
  other: 'Other',
}

const c = computed(() => props.compensation)
const confidence = computed(() => (c.value ? CONFIDENCE[c.value.confidence] : null))

const baseText = computed(() => {
  if (!c.value || (c.value.baseMin == null && c.value.baseMax == null)) return ''
  const range = formatRange(c.value.baseMin, c.value.baseMax, c.value.currency)
  return c.value.basePeriod ? `${range} per ${c.value.basePeriod}` : range
})

const baseAnnualText = computed(() => {
  if (!c.value || c.value.basePeriod === 'year') return ''
  return formatRange(c.value.baseAnnualMin, c.value.baseAnnualMax, c.value.currency)
})

const totalText = computed(() => (c.value ? formatRange(c.value.totalEstimateMin, c.value.totalEstimateMax, c.value.currency) : ''))

// What the total counts, from the function that computed it (shared/utils/comp-parts.ts).
const parts = computed(() => (c.value ? compParts(c.value) : null))
const hasTotal = computed(() => parts.value?.totalMin != null)
/** "Base $157K to $213K plus 401(k) match ($6,280 to $8,520, 4% of base). 7 other benefits have no dollar value." */
const sourcesText = computed(() => (parts.value && c.value ? totalSourcesText(parts.value, c.value.currency) : ''))
const countedPart = (kind: CompPart['kind']) => (hasTotal.value ? parts.value?.counted.find(p => p.kind === kind) ?? null : null)

/** Bonus or equity: the amount the total counts, else the plain phrase. */
function extraText(kind: 'bonus' | 'equity', extra: { estimatedAnnual: number | null } | null | undefined): string {
  const p = countedPart(kind)
  if (!p) return payExtraText(extra, c.value?.currency)
  const pct = partPercent(p)
  return `${partAmount(p, c.value?.currency)} a year${pct ? `, ${pct}` : ''}`
}

const BENEFITS_SHOWN = 6
const showAllBenefits = ref(false)

const same = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '') === (b ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')

/** Counted benefits first, then valued but left out, then the rest; detail and quote only when they say more than the name. */
const benefitRows = computed(() => {
  const rank = { counted: 0, left_out: 1, unvalued: 2 }
  return (c.value?.benefits ?? []).map((b) => {
    const part = hasTotal.value && parts.value ? benefitPart(parts.value, b) : null
    const state: keyof typeof rank = part ? 'counted' : b.estimatedAnnualValue != null ? 'left_out' : 'unvalued'
    const value = part ? `${partAmount(part, c.value?.currency)} a year` : b.estimatedAnnualValue != null ? `${formatMoney(b.estimatedAnnualValue)} a year` : 'No dollar value'
    return {
      ...b,
      state,
      value,
      showDetail: !!b.detail && !same(b.detail, b.name),
      showQuote: !!b.quote && !same(b.quote, b.name) && !same(b.quote, b.detail),
    }
  }).sort((x, y) => rank[x.state] - rank[y.state])
})
const benefitsHeading = computed(() => {
  const n = benefitRows.value.length
  const counted = benefitRows.value.filter(r => r.state === 'counted').length
  if (!hasTotal.value) return `Benefits (${n})`
  return counted ? `Benefits: ${counted} of ${n} counted in the total` : `Benefits: ${n}, none counted in the total`
})
const visibleBenefits = computed(() => (showAllBenefits.value ? benefitRows.value : benefitRows.value.slice(0, BENEFITS_SHOWN)))
</script>

<template>
  <v-card variant="outlined" class="comp-breakdown">
    <v-card-item>
      <v-card-title class="text-subtitle-1 font-weight-medium">
        Total compensation
      </v-card-title>
      <template v-if="confidence" #append>
        <v-chip size="small" variant="tonal" :color="confidence.color">
          {{ confidence.label }}
        </v-chip>
      </template>
    </v-card-item>

    <v-card-text v-if="!c" class="text-body-2 text-medium-emphasis">
      {{ enrichedAt ? 'Compensation could not be read from this posting.' : `Not read yet. The scheduled pipeline reads pay and benefits from the full posting. It runs ${PIPELINE_SCHEDULE_TEXT}.` }}
    </v-card-text>

    <v-card-text v-else>
      <div v-if="totalText" class="comp-breakdown__total">
        <div class="text-caption text-medium-emphasis">
          Estimated total per year
        </div>
        <div class="text-h5 font-weight-bold">
          {{ totalText }}
        </div>
        <div class="text-caption text-medium-emphasis">
          {{ sourcesText }}
        </div>
      </div>

      <div class="comp-breakdown__items">
        <!-- Base -->
        <div class="comp-breakdown__item">
          <div class="comp-breakdown__item-head">
            <span class="text-body-2 font-weight-medium">Base pay</span>
            <span class="text-body-2">{{ baseText || 'Not stated' }}</span>
          </div>
          <div v-if="baseAnnualText" class="text-caption text-medium-emphasis">
            {{ baseAnnualText }} a year
          </div>
          <blockquote v-if="c.baseQuote" class="comp-breakdown__quote">
            {{ c.baseQuote }}
          </blockquote>
        </div>

        <!-- Bonus -->
        <div v-if="c.bonus" class="comp-breakdown__item">
          <div class="comp-breakdown__item-head">
            <span class="text-body-2 font-weight-medium">Bonus</span>
            <span class="text-body-2">{{ extraText('bonus', c.bonus) }}<span v-if="countedPart('bonus')" class="comp-breakdown__tag">Counted</span></span>
          </div>
          <div class="text-caption text-medium-emphasis">
            {{ c.bonus.description }}
          </div>
          <blockquote class="comp-breakdown__quote">
            {{ c.bonus.quote }}
          </blockquote>
        </div>

        <!-- Equity -->
        <div v-if="c.equity" class="comp-breakdown__item">
          <div class="comp-breakdown__item-head">
            <span class="text-body-2 font-weight-medium">Equity</span>
            <span class="text-body-2">{{ extraText('equity', c.equity) }}<span v-if="countedPart('equity')" class="comp-breakdown__tag">Counted</span></span>
          </div>
          <div class="text-caption text-medium-emphasis">
            {{ c.equity.description }}
          </div>
          <blockquote class="comp-breakdown__quote">
            {{ c.equity.quote }}
          </blockquote>
        </div>
      </div>

      <div v-if="benefitRows.length" class="comp-breakdown__benefits">
        <div class="text-body-2 font-weight-medium mb-2">
          {{ benefitsHeading }}
        </div>
        <div v-for="(b, i) in visibleBenefits" :key="i" class="comp-breakdown__benefit">
          <div class="comp-breakdown__item-head">
            <span class="text-body-2">
              {{ b.name }}
              <v-chip size="x-small" variant="outlined" class="ml-1">{{ BENEFIT_LABELS[b.category] ?? b.category }}</v-chip>
            </span>
            <span class="text-body-2" :class="{ 'text-medium-emphasis': b.state !== 'counted' }">
              {{ b.value }}<span v-if="b.state === 'counted'" class="comp-breakdown__tag">Counted</span><span v-else-if="b.state === 'left_out'" class="comp-breakdown__tag">Not counted</span>
            </span>
          </div>
          <div v-if="b.showDetail" class="text-caption text-medium-emphasis">
            {{ b.detail }}
          </div>
          <blockquote v-if="b.showQuote" class="comp-breakdown__quote">
            {{ b.quote }}
          </blockquote>
        </div>
        <v-btn
          v-if="benefitRows.length > BENEFITS_SHOWN"
          variant="text"
          size="small"
          color="primary"
          class="px-1 ms-n1"
          :append-icon="showAllBenefits ? 'mdi-chevron-up' : 'mdi-chevron-down'"
          @click="showAllBenefits = !showAllBenefits"
        >
          {{ showAllBenefits ? 'Show fewer' : `Show all ${benefitRows.length} benefits` }}
        </v-btn>
      </div>

      <div v-if="c.notes" class="comp-breakdown__notes text-caption">
        <v-icon icon="mdi-information-outline" size="14" class="mr-1" />{{ payFiguresInText(c.notes) }}
      </div>
    </v-card-text>
  </v-card>
</template>

<style scoped lang="scss">
.comp-breakdown {
  &__total {
    padding: 12px 16px;
    margin-bottom: 16px;
    border-radius: 10px;
    background: rgb(var(--v-theme-surface-bright));
  }

  &__items {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  &__item-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 4px 12px;
  }

  &__quote {
    margin: 6px 0 0;
    padding: 4px 10px;
    border-left: 2px solid rgb(var(--v-theme-surface-light));
    font-size: 0.8125rem;
    line-height: 1.5;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    overflow-wrap: anywhere;
  }

  &__benefits {
    margin-top: 20px;
    padding-top: 16px;
    border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  }

  &__benefit {
    margin-bottom: 10px;
  }

  // A neutral status tag (design-system.md): what the total does with an amount.
  &__tag {
    display: inline-block;
    margin-left: 6px;
    padding: 1px 8px;
    border-radius: 6px;
    font-size: 0.75rem;
    font-weight: 500;
    line-height: 1.4;
    vertical-align: 1px;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    background: rgb(var(--v-theme-surface-light));
    white-space: nowrap;
  }

  &__notes {
    margin-top: 16px;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    line-height: 1.5;
  }
}
</style>

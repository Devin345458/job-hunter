<script setup lang="ts">
import type { CompensationBreakdown } from '#shared/types/pipeline'
import { PIPELINE_SCHEDULE_TEXT } from '#shared/utils/schedule'
import { formatMoney, formatRange } from './format'
import { payExtraText } from '#shared/utils/pay-format'

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

const BENEFITS_SHOWN = 6
const showAllBenefits = ref(false)

const same = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '') === (b ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')

/** Valued benefits first; detail and quote only when they say more than the name. */
const benefitRows = computed(() => {
  const list = [...(c.value?.benefits ?? [])].sort((a, b) => Number(b.estimatedAnnualValue != null) - Number(a.estimatedAnnualValue != null))
  return list.map(b => ({
    ...b,
    showDetail: !!b.detail && !same(b.detail, b.name),
    showQuote: !!b.quote && !same(b.quote, b.name) && !same(b.quote, b.detail),
  }))
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
          Base, plus bonus, equity, and benefits only where the posting gives a figure.
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
            <span class="text-body-2">{{ payExtraText(c.bonus, c.currency) }}</span>
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
            <span class="text-body-2">{{ payExtraText(c.equity, c.currency) }}</span>
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
          Benefits ({{ benefitRows.length }})
        </div>
        <div v-for="(b, i) in visibleBenefits" :key="i" class="comp-breakdown__benefit">
          <div class="comp-breakdown__item-head">
            <span class="text-body-2">
              {{ b.name }}
              <v-chip size="x-small" variant="outlined" class="ml-1">{{ BENEFIT_LABELS[b.category] ?? b.category }}</v-chip>
            </span>
            <span class="text-body-2" :class="{ 'text-medium-emphasis': b.estimatedAnnualValue == null }">
              {{ b.estimatedAnnualValue != null ? `${formatMoney(b.estimatedAnnualValue)} a year` : 'Not valued' }}
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
        <v-icon icon="mdi-information-outline" size="14" class="mr-1" />{{ c.notes }}
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

  &__notes {
    margin-top: 16px;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    line-height: 1.5;
  }
}
</style>

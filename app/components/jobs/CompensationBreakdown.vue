<script setup lang="ts">
import type { CompensationBreakdown } from '#shared/types/pipeline'
import { formatMoney, formatRange } from './format'

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
      {{ enrichedAt ? 'Compensation could not be read from this posting.' : 'Not extracted yet. The daily pipeline reads pay and benefits from the full posting.' }}
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
            <span class="text-body-2">{{ c.bonus.estimatedAnnual != null ? `${formatMoney(c.bonus.estimatedAnnual)} a year` : 'No figure' }}</span>
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
            <span class="text-body-2">{{ c.equity.estimatedAnnual != null ? `${formatMoney(c.equity.estimatedAnnual)} a year` : 'No figure' }}</span>
          </div>
          <div class="text-caption text-medium-emphasis">
            {{ c.equity.description }}
          </div>
          <blockquote class="comp-breakdown__quote">
            {{ c.equity.quote }}
          </blockquote>
        </div>
      </div>

      <div v-if="c.benefits.length" class="comp-breakdown__benefits">
        <div class="text-body-2 font-weight-medium mb-2">
          Benefits ({{ c.benefits.length }})
        </div>
        <div v-for="(b, i) in c.benefits" :key="i" class="comp-breakdown__benefit">
          <div class="comp-breakdown__item-head">
            <span class="text-body-2">
              {{ b.name }}
              <v-chip size="x-small" variant="outlined" class="ml-1">{{ BENEFIT_LABELS[b.category] ?? b.category }}</v-chip>
            </span>
            <span class="text-body-2" :class="{ 'text-medium-emphasis': b.estimatedAnnualValue == null }">
              {{ b.estimatedAnnualValue != null ? `${formatMoney(b.estimatedAnnualValue)} a year` : 'Not valued' }}
            </span>
          </div>
          <div v-if="b.detail" class="text-caption text-medium-emphasis">
            {{ b.detail }}
          </div>
          <blockquote class="comp-breakdown__quote">
            {{ b.quote }}
          </blockquote>
        </div>
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
    border-radius: 8px;
    background: rgba(var(--v-theme-primary), 0.08);
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
    border-left: 3px solid rgba(var(--v-theme-primary), 0.5);
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
    margin-bottom: 14px;
  }

  &__notes {
    margin-top: 16px;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    line-height: 1.5;
  }
}
</style>

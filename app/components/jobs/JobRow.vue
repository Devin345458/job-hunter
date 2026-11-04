<script setup lang="ts">
import type { JobListItem } from '~/composables/useJobs'
import { jobStateMeta, postingLocations } from './format'
import { properName } from '#shared/utils/names'
import { countText, payRange } from '#shared/utils/pay-format'

// One job in the Jobs list. Desktop and tablet: columns that compare down the page (score, the
// role, one status mark, base pay, total pay; figures right-aligned in tabular digits). Phone: two
// lines, the score, title and total on the first, company, base and state on the second.
const props = defineProps<{
  job: JobListItem
}>()

const state = computed(() => jobStateMeta(props.job.status, props.job.application))
/** A job nothing has happened to yet carries no mark; every other state gets its one pill. */
const showState = computed(() => !(state.value.label === 'New' && !props.job.application))

const alsoOnText = computed(() => (props.job.alsoOn ?? []).map(properName).join(', '))
const postingCount = computed(() => props.job.postingCount ?? 1)
const locations = computed(() => (postingCount.value > 1 ? postingLocations(props.job.postings ?? []) : []))
const locationText = computed(() => (postingCount.value > 1 && locations.value.length ? locations.value.join(' · ') : props.job.location))

const currency = computed(() => props.job.salaryCurrency || 'USD')
/** Base: the yearly figure from the pay breakdown, else the listing's own range. */
const base = computed(() => payRange(props.job.baseAnnualMin ?? props.job.salaryMin, props.job.baseAnnualMax ?? props.job.salaryMax, currency.value))
/** Total: the same estimate the Review card and the job page print; the single estimate when no range was read. */
const total = computed(() => payRange(props.job.totalEstimateMin ?? props.job.totalCompEstimate, props.job.totalEstimateMax ?? props.job.totalCompEstimate, currency.value))

const remoteLabel = computed(() => ({ remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-site' } as Record<string, string>)[props.job.remoteType ?? ''] ?? '')

/** Line two of the role cell: where, how, and how many postings, in plain words. */
const meta = computed(() => {
  const parts: string[] = [props.job.company]
  if (locationText.value) parts.push(locationText.value)
  if (remoteLabel.value && !/remote/i.test(locationText.value ?? '')) parts.push(remoteLabel.value)
  if (postingCount.value > 1) parts.push(`${countText(postingCount.value)} postings`)
  if (alsoOnText.value) parts.push(`Also on ${alsoOnText.value}`)
  return parts.join(' · ')
})
</script>

<template>
  <NuxtLink :to="`/jobs/${job.id}`" class="jr" :title="`${job.title} at ${job.company}`">
    <span class="jr__score" :class="{ 'jr__score--none': job.matchScore == null }">
      <template v-if="job.matchScore != null"><span class="jr__sr">Match </span>{{ job.matchScore }}</template>
      <span v-else class="jr__dash" role="img" aria-label="Not scored yet" />
    </span>

    <span class="jr__role">
      <span class="jr__title">{{ job.title }}</span>
      <span class="jr__meta"><span v-if="showState || job.isSandbox" class="jr__meta-state" :class="`jr__meta-state--${job.isSandbox ? 'neutral' : state.color}`">{{ job.isSandbox ? 'Sandbox' : state.label }} · </span>{{ meta }}</span>
    </span>

    <span class="jr__state">
      <span v-if="job.isSandbox" class="jr__pill jr__pill--neutral">Sandbox</span>
      <span v-else-if="showState" class="jr__pill" :class="`jr__pill--${state.color}`">{{ state.label }}</span>
    </span>

    <span class="jr__num jr__base">
      <span class="jr__sr">Base </span>
      <template v-if="base">{{ base }}</template>
      <span v-else class="jr__none">Not stated</span>
    </span>

    <span class="jr__num jr__total">
      <span class="jr__sr">Total </span>
      <template v-if="total">{{ total }}</template>
      <span v-else class="jr__dash" role="img" aria-label="No total estimate yet" />
    </span>
  </NuxtLink>
</template>

<style scoped lang="scss">
// Columns: score 48 | role | state 148 | base 156 | total 156. The list header in pages/jobs uses
// the same template, so every figure ends on one right edge down the page.
.jr {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr) 148px 156px 156px;
  align-items: center;
  column-gap: 16px;
  min-height: 60px;
  padding: 10px 12px;
  border-radius: 10px;
  color: inherit;
  text-decoration: none;
  transition: background-color 0.12s cubic-bezier(0.23, 1, 0.32, 1);

  &:hover {
    background: rgb(var(--v-theme-surface));
  }

  &:focus-visible {
    outline: 2px solid rgb(var(--v-theme-primary));
    outline-offset: -2px;
  }

  &__sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  // The match score: the one data hue, right-aligned.
  &__score {
    text-align: right;
    font-size: 1.0625rem;
    font-weight: 600;
    color: rgb(var(--v-theme-score));
  }

  &__role {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  &__title {
    font-size: 0.875rem;
    font-weight: 600;
    line-height: 1.35;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  &__meta {
    font-size: 0.8125rem;
    line-height: 1.35;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  &__state {
    min-width: 0;
  }

  // The phone has no state column: the state leads line two instead, so it is never dropped.
  &__meta-state {
    display: none;
    font-weight: 500;

    &--warning { color: rgb(var(--v-theme-warning)); }
    &--error { color: rgb(var(--v-theme-error)); }
    &--success { color: rgb(var(--v-theme-success)); }
  }

  // Status as a pale pair: the hue's text on a 14% tint of itself. Neutral states read in ink.
  &__pill {
    display: inline-block;
    max-width: 100%;
    padding: 1px 8px;
    border-radius: 6px;
    font-size: 0.75rem;
    font-weight: 500;
    line-height: 1.5;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    vertical-align: middle;

    @each $c in warning, error, success {
      &--#{$c} {
        color: rgb(var(--v-theme-#{$c}));
        background: rgba(var(--v-theme-#{$c}), 0.14);
      }
    }

    &--primary,
    &--info,
    &--secondary,
    &--grey,
    &--neutral {
      color: rgb(var(--v-theme-on-surface));
      background: rgb(var(--v-theme-surface-light));
    }
  }

  &__num {
    text-align: right;
    font-size: 0.875rem;
    white-space: nowrap;
  }

  &__none {
    font-size: 0.8125rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  // A missing figure: a short gray mark, never a dash at value size.
  &__dash {
    display: inline-block;
    width: 8px;
    height: 2px;
    border-radius: 1px;
    vertical-align: middle;
    background: rgba(var(--v-theme-on-surface), 0.4);
  }

  // Tablet: the state moves under the title so the pay columns keep their width.
  @media (max-width: 1099.98px) {
    grid-template-columns: 40px minmax(0, 1fr) 140px 140px;
    grid-template-areas:
      'score role base total'
      'score state base total';

    &__score { grid-area: score; }
    &__role { grid-area: role; }
    &__state { grid-area: state; }
    &__base { grid-area: base; }
    &__total { grid-area: total; }
  }

  // Phone: two-line rows. Line 1: score, title, total. Line 2: company and place, base, state.
  @media (max-width: 639.98px) {
    grid-template-columns: 32px minmax(0, 1fr) auto;
    grid-template-areas:
      'score role total'
      'score meta base';
    column-gap: 10px;
    row-gap: 2px;
    min-height: 64px;
    padding: 10px 4px;
    border-radius: 0;
    border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));

    &__score {
      align-self: start;
      font-size: 1rem;
      padding-top: 1px;
    }

    &__role {
      display: contents;
    }

    &__title {
      grid-area: role;
    }

    &__meta {
      grid-area: meta;
      font-size: 0.8125rem;
    }

    &__state {
      display: none;
    }

    &__meta-state {
      display: inline;
    }

    &__total {
      font-weight: 600;
    }

    &__base {
      font-size: 0.8125rem;
      color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    }
  }
}
</style>

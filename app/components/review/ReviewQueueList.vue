<script setup lang="ts">
import type { ReviewItem } from '#shared/types/pipeline'
import type { QueueGroups } from '~/composables/useReviewQueue'
import { GROUP_LABEL, clockTime, itemStatusMeta, moneyRange } from '~/composables/review/format'

// The queue, grouped by what each application needs from Devin. Decide-first; the groups
// below it only appear when they have something in them.
const props = defineProps<{
  groups: QueueGroups
  selectedId: number | null
}>()

const emit = defineEmits<{ select: [id: number] }>()

const sections = computed(() => [
  { key: 'decide', label: GROUP_LABEL.decide, items: props.groups.decide, empty: 'Nothing left to decide.' },
  { key: 'attention', label: GROUP_LABEL.attention, items: props.groups.attention, empty: null },
  { key: 'sending', label: 'Sending', items: props.groups.sending, empty: null },
  { key: 'sent', label: 'Sent recently', items: props.groups.sent, empty: null },
].filter(s => s.items.length > 0 || s.empty))

/**
 * Base pay, the figure the job card and the review card show, labeled so it is never read as the
 * total. Only a posting with no base figure falls back to the estimated total, labeled as such.
 */
function pay(item: ReviewItem) {
  const c = item.compensation
  const currency = c?.currency || item.job.salaryCurrency || 'USD'
  const base = moneyRange(c?.baseAnnualMin ?? item.job.salaryMin, c?.baseAnnualMax ?? item.job.salaryMax, currency)
  if (base) return `${base} base`
  const total = moneyRange(c?.totalEstimateMin, c?.totalEstimateMax, currency)
  return total ? `${total} est. total` : ''
}

function blockingCount(item: ReviewItem) {
  return item.openQuestions.filter(q => q.blocking).length
}
</script>

<template>
  <nav class="ql" aria-label="Review queue">
    <section v-for="s in sections" :key="s.key" class="ql__group">
      <h2 class="ql__label">
        {{ s.label }}
        <span class="ql__count tabular">{{ s.items.length }}</span>
      </h2>
      <p v-if="!s.items.length && s.empty" class="ql__empty">{{ s.empty }}</p>
      <ul class="ql__list">
        <li v-for="item in s.items" :key="item.applicationId">
          <button
            type="button"
            class="ql__row"
            :class="{ 'ql__row--on': item.applicationId === selectedId }"
            :aria-current="item.applicationId === selectedId ? 'true' : undefined"
            @click="emit('select', item.applicationId)"
          >
            <span class="ql__score tabular" :class="{ 'ql__score--dim': s.key !== 'decide' }">{{ item.score?.final ?? '?' }}</span>
            <span class="ql__main">
              <span class="ql__title">{{ item.job.title }}</span>
              <span class="ql__sub">
                {{ item.job.company }}{{ pay(item) ? ` · ${pay(item)}` : '' }}
              </span>
              <span v-if="s.key === 'decide' && blockingCount(item)" class="ql__flag ql__flag--warning">
                <v-icon icon="mdi-comment-question-outline" size="13" />
                {{ blockingCount(item) }} to answer
              </span>
              <span v-else-if="s.key !== 'decide'" class="ql__flag" :class="`ql__flag--${itemStatusMeta(item).color}`">
                <v-progress-circular v-if="s.key === 'sending'" indeterminate size="11" width="2" />
                <v-icon v-else :icon="itemStatusMeta(item).icon" size="13" />
                {{ itemStatusMeta(item).label }}{{ item.status === 'submitted' && item.submission ? ` ${clockTime(item.submission.submittedAt)}` : '' }}
              </span>
            </span>
            <span v-if="item.isSandbox" class="ql__sandbox" title="Sandbox or fixture data">S</span>
          </button>
        </li>
      </ul>
    </section>
  </nav>
</template>

<style scoped lang="scss">
.ql {
  &__group + &__group {
    margin-top: 18px;
  }

  &__label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.02em;
    margin: 0 0 6px;
    padding: 0 8px;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__count {
    font-weight: 600;
    color: rgb(var(--v-theme-on-surface));
  }

  &__empty {
    margin: 0;
    padding: 8px;
    font-size: 0.8125rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  &__row {
    width: 100%;
    display: flex;
    align-items: flex-start;
    gap: 12px;
    min-height: 56px;
    padding: 10px 8px;
    border-radius: 8px;
    text-align: left;
    color: inherit;
    position: relative;
    transition: background-color 0.12s cubic-bezier(0.23, 1, 0.32, 1);

    &:hover {
      background: rgba(var(--v-theme-on-surface), 0.04);
    }

    &--on {
      background: rgba(var(--v-theme-primary), 0.1);

      &:hover { background: rgba(var(--v-theme-primary), 0.13); }

      &::before {
        content: '';
        position: absolute;
        left: 0;
        top: 10px;
        bottom: 10px;
        width: 3px;
        border-radius: 2px;
        background: rgb(var(--v-theme-primary));
      }
    }
  }

  &__score {
    width: 30px;
    flex-shrink: 0;
    text-align: right;
    font-size: 1.0625rem;
    font-weight: 700;
    line-height: 1.3;
    letter-spacing: -0.02em;

    &--dim {
      color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
      font-weight: 600;
    }
  }

  &__main {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }

  &__title {
    font-size: 0.875rem;
    font-weight: 600;
    line-height: 1.35;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
  }

  &__sub {
    font-size: 0.75rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  &__flag {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 0.75rem;
    font-weight: 600;
    margin-top: 1px;

    @each $c in primary, warning, error, success, secondary {
      &--#{$c} { color: rgb(var(--v-theme-#{$c})); }
    }
  }

  &__sandbox {
    flex-shrink: 0;
    width: 18px;
    height: 18px;
    border-radius: 4px;
    display: grid;
    place-items: center;
    font-size: 0.75rem;
    font-weight: 700;
    color: rgb(var(--v-theme-info));
    border: 1px dashed rgba(var(--v-theme-info), 0.6);
    margin-top: 2px;
  }
}
</style>

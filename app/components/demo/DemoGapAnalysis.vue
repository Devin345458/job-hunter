<script setup lang="ts">
import { fixPlurals, gapSummaryText, plainKnowledgeRefs } from '#shared/utils/plain-text'
import type { GapAnalysis, GapItem } from '#shared/types/pipeline'

// The gap analysis for one application: each requirement Devin's record lacks and what the
// pipeline decided to do about it.
// showSummary: false where a section header above already prints the summary (the review card).
withDefaults(defineProps<{ gap: GapAnalysis | null; showSummary?: boolean }>(), { showSummary: true })

const DECISION: Record<GapItem['decision'], { label: string; icon: string; color: string }> = {
  demo: { label: 'Demo idea', icon: 'mdi-flask-outline', color: 'secondary' },
  ask: { label: 'Asked you', icon: 'mdi-chat-question-outline', color: 'warning' },
  reframe: { label: 'Use existing experience', icon: 'mdi-swap-horizontal', color: 'info' },
  skip: { label: 'Left as a gap', icon: 'mdi-minus-circle-outline', color: 'grey' },
}
</script>

<template>
  <div class="gap-analysis">
    <p v-if="!gap" class="text-body-2 text-medium-emphasis">
      No gap analysis yet.
    </p>
    <template v-else>
      <p v-if="showSummary" class="gap-analysis__summary text-body-2 mb-4">
        {{ fixPlurals(plainKnowledgeRefs(gapSummaryText(gap.summary, null))) }}
      </p>
      <div v-for="(item, i) in gap.items" :key="i" class="gap-analysis__item">
        <div class="gap-analysis__requirement text-body-1 font-weight-medium">
          {{ item.requirement }}
        </div>
        <div class="gap-analysis__row text-body-2">
          <span class="gap-analysis__decision" :class="`text-${DECISION[item.decision].color}`">
            <v-icon :icon="DECISION[item.decision].icon" size="16" />
            {{ DECISION[item.decision].label }}
          </span>
          <span v-if="item.mustHave" class="gap-analysis__must">Must have</span>
        </div>
        <div class="gap-analysis__rationale text-body-2">
          {{ fixPlurals(plainKnowledgeRefs(item.rationale)) }}
        </div>
        <div v-if="item.decision === 'reframe' && item.evidence" class="gap-analysis__evidence text-body-2">
          Rests on your knowledge base entry: {{ plainKnowledgeRefs(item.evidence) }}
        </div>
        <div v-if="item.demoIdea" class="gap-analysis__idea text-body-2">
          <strong>{{ item.demoIdea.title }}</strong>: {{ item.demoIdea.summary }}
          <span class="gap-analysis__meta">{{ item.demoIdea.stack.join(', ') }}, about {{ item.demoIdea.scopeHours }} hours</span>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped lang="scss">
.gap-analysis {
  &__summary {
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__item {
    padding: 14px 0;
    border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));

    &:first-of-type {
      border-top: 0;
      padding-top: 0;
    }
  }

  &__row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 12px;
    margin-top: 2px;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__decision {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  &__must {
    font-weight: 500;
    color: rgb(var(--v-theme-on-surface));
  }

  &__rationale {
    margin-top: 4px;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    line-height: 1.6;
  }

  &__evidence {
    margin-top: 4px;
    font-size: 0.8125rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__idea {
    margin-top: 10px;
    padding: 10px 14px;
    border-radius: 8px;
    background: rgb(var(--v-theme-surface-bright));
    line-height: 1.6;
  }

  &__meta {
    display: block;
    margin-top: 4px;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }
}
</style>

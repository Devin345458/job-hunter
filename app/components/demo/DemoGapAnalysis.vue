<script setup lang="ts">
import { fixPlurals, plainKnowledgeRefs } from '#shared/utils/plain-text'
import type { GapAnalysis, GapItem } from '#shared/types/pipeline'

// The gap analysis for one application: each requirement Devin's record lacks and what the
// pipeline decided to do about it.
defineProps<{ gap: GapAnalysis | null }>()

const DECISION: Record<GapItem['decision'], { label: string; color: string; icon: string }> = {
  demo: { label: 'Demo idea', color: 'secondary', icon: 'mdi-flask-outline' },
  ask: { label: 'Asked you', color: 'secondary', icon: 'mdi-chat-question-outline' },
  reframe: { label: 'Use existing experience', color: 'info', icon: 'mdi-swap-horizontal' },
  skip: { label: 'Skip', color: 'grey', icon: 'mdi-minus-circle-outline' },
}
</script>

<template>
  <div class="gap-analysis">
    <p v-if="!gap" class="text-body-2 text-medium-emphasis">
      No gap analysis yet.
    </p>
    <template v-else>
      <p class="gap-analysis__summary text-body-2 mb-4">
        {{ fixPlurals(plainKnowledgeRefs(gap.summary)) }}
      </p>
      <div v-for="(item, i) in gap.items" :key="i" class="gap-analysis__item">
        <div class="gap-analysis__row">
          <v-chip :color="DECISION[item.decision].color" variant="tonal" size="small" :prepend-icon="DECISION[item.decision].icon">
            {{ DECISION[item.decision].label }}
          </v-chip>
          <v-chip v-if="item.mustHave" size="small" variant="outlined">
            Must have
          </v-chip>
        </div>
        <div class="gap-analysis__requirement text-body-1 font-weight-medium">
          {{ item.requirement }}
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
    gap: 6px;
    margin-bottom: 8px;
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
    background: rgba(var(--v-theme-secondary), 0.08);
    line-height: 1.6;
  }

  &__meta {
    display: block;
    margin-top: 4px;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }
}
</style>

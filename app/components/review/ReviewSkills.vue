<script setup lang="ts">
import type { Requirement, ScoreBreakdown } from '#shared/types/pipeline'
import { knowledgeRef } from '~/composables/review/format'

// Skills fit: matched and missing skills first, then each posting requirement with what the
// knowledge base says about it.
const props = defineProps<{
  score: ScoreBreakdown | null
  requirements: Requirement[]
}>()

const STATUS: Record<Requirement['status'], { label: string; icon: string; color: string }> = {
  have: { label: 'Have', icon: 'mdi-check', color: 'success' },
  partial: { label: 'Partly', icon: 'mdi-circle-half-full', color: 'warning' },
  lack: { label: 'Lack', icon: 'mdi-close', color: 'error' },
  unknown: { label: 'Unknown', icon: 'mdi-help', color: 'secondary' },
}

const sorted = computed(() => [...props.requirements].sort((a, b) => Number(b.mustHave) - Number(a.mustHave)))
</script>

<template>
  <div class="skills">
    <p v-if="score?.skills.reasoning" class="skills__reason">{{ score.skills.reasoning }}</p>

    <div v-if="score" class="skills__sets">
      <div class="skills__set">
        <div class="skills__set-label">Matched <span class="tabular">{{ score.skills.matched.length }}</span></div>
        <div class="skills__chips">
          <v-chip v-for="s in score.skills.matched" :key="s" size="small" color="success" variant="tonal" prepend-icon="mdi-check">{{ s }}</v-chip>
          <span v-if="!score.skills.matched.length" class="skills__none">None</span>
        </div>
      </div>
      <div class="skills__set">
        <div class="skills__set-label">Missing <span class="tabular">{{ score.skills.missing.length }}</span></div>
        <div class="skills__chips">
          <v-chip v-for="s in score.skills.missing" :key="s" size="small" color="error" variant="tonal" prepend-icon="mdi-minus">{{ s }}</v-chip>
          <span v-if="!score.skills.missing.length" class="skills__none">Nothing missing</span>
        </div>
      </div>
    </div>

    <ul v-if="sorted.length" class="skills__reqs" aria-label="Posting requirements">
      <li v-for="(r, i) in sorted" :key="i" class="skills__req">
        <v-icon :icon="STATUS[r.status].icon" :color="STATUS[r.status].color" size="16" class="skills__req-icon" />
        <div class="skills__req-body">
          <span class="skills__req-text">{{ r.text }}</span>
          <span class="skills__req-meta">
            {{ r.mustHave ? 'Must have' : 'Nice to have' }} · {{ STATUS[r.status].label }}{{ r.evidence ? ` · knowledge base: ${knowledgeRef(r.evidence)}` : '' }}
          </span>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped lang="scss">
.skills {
  &__reason {
    margin: 0 0 12px;
    font-size: 0.875rem;
    color: rgba(var(--v-theme-on-surface), 0.86);
  }

  &__sets {
    display: grid;
    gap: 12px;
    margin-bottom: 14px;
  }

  &__set-label {
    font-size: 0.75rem;
    font-weight: 600;
    margin-bottom: 6px;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  &__none {
    font-size: 0.8125rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__reqs {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  &__req {
    display: flex;
    gap: 10px;
    padding: 8px 0;
    border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  }

  &__req-icon {
    margin-top: 3px;
    flex-shrink: 0;
  }

  &__req-body {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }

  &__req-text {
    font-size: 0.875rem;
  }

  &__req-meta {
    font-size: 0.75rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }
}
</style>

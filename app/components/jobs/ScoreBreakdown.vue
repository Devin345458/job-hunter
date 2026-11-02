<script setup lang="ts">
import { plainQuestionRefs } from '#shared/utils/plain-text'
import type { QuestionView, ScoreBreakdown } from '#shared/types/pipeline'
import { formatMoney, RECOMMENDATION_LABELS, scoreColor } from './format'

interface HistoryRow {
  score: number
  skillsScore: number | null
  compScore: number | null
  learnedAdjustment: number | null
  reason: string
  computedAt: string
}

const props = defineProps<{
  score: ScoreBreakdown | null
  history?: HistoryRow[]
  questions?: QuestionView[]
}>()

const PART_LABELS = [
  { key: 'mustHaves', label: 'Must-have requirements', max: 45 },
  { key: 'stack', label: 'Tech stack', max: 25 },
  { key: 'seniority', label: 'Seniority', max: 20 },
  { key: 'domain', label: 'Domain', max: 10 },
] as const

const parts = computed(() => {
  const p = props.score?.skills.parts
  return p ? PART_LABELS.map(d => ({ ...d, value: p[d.key] })) : []
})

const skillsWeight = computed(() => Math.round((props.score?.weights.skills ?? 0) * 100))
const compWeight = computed(() => Math.round((props.score?.weights.compensation ?? 0) * 100))
const preferenceQuestions = computed(() => (props.questions ?? []).filter(q => q.kind === 'preference'))

function signed(n: number) {
  return n > 0 ? `+${n}` : String(n)
}
</script>

<template>
  <v-card variant="outlined" class="score-breakdown">
    <v-card-item>
      <v-card-title class="text-subtitle-1 font-weight-medium">
        Match score
      </v-card-title>
    </v-card-item>

    <v-card-text v-if="!score" class="text-center pa-6">
      <v-icon icon="mdi-chart-line" size="40" class="mb-3 score-breakdown__muted-icon" />
      <p class="text-body-2 text-medium-emphasis mb-1">
        Not scored yet
      </p>
      <p class="text-caption text-medium-emphasis">
        Jobs are enriched and scored by the daily pipeline at 6 AM Central.
      </p>
    </v-card-text>

    <v-card-text v-else>
      <div class="score-breakdown__summary">
        <v-progress-circular :model-value="score.final" :size="88" :width="7" :color="scoreColor(score.final)">
          <span class="text-h5 font-weight-bold">{{ score.final }}</span>
        </v-progress-circular>
        <div>
          <div class="text-body-1 font-weight-medium" :class="`text-${scoreColor(score.final)}`">
            {{ RECOMMENDATION_LABELS[score.recommendation] }}
          </div>
          <div class="text-caption text-medium-emphasis">
            {{ skillsWeight }}% skills, {{ compWeight }}% compensation{{ score.learned.total ? `, ${signed(score.learned.total)} learned` : '' }}
          </div>
        </div>
      </div>

      <!-- Skills -->
      <section class="score-breakdown__section">
        <div class="score-breakdown__row">
          <span class="text-body-2 font-weight-medium">Skills</span>
          <v-chip size="small" variant="tonal" :color="scoreColor(score.skills.score)">
            {{ score.skills.score }} / 100
          </v-chip>
        </div>
        <div v-for="p in parts" :key="p.key" class="score-breakdown__part">
          <div class="score-breakdown__part-label text-caption">
            <span>{{ p.label }}</span>
            <span>{{ p.value }} / {{ p.max }}</span>
          </div>
          <v-progress-linear :model-value="(p.value / p.max) * 100" :color="scoreColor((p.value / p.max) * 100)" height="6" rounded />
        </div>
        <p class="text-body-2 score-breakdown__reasoning">
          {{ score.skills.reasoning }}
        </p>
        <div v-if="score.skills.matched.length" class="score-breakdown__chips">
          <span class="text-caption text-medium-emphasis score-breakdown__chips-label">Has</span>
          <v-chip v-for="m in score.skills.matched" :key="m" size="x-small" variant="tonal" color="success">
            {{ m }}
          </v-chip>
        </div>
        <div v-if="score.skills.missing.length" class="score-breakdown__chips">
          <span class="text-caption text-medium-emphasis score-breakdown__chips-label">Missing</span>
          <v-chip v-for="m in score.skills.missing" :key="m" size="x-small" variant="tonal" color="error">
            {{ m }}
          </v-chip>
        </div>
      </section>

      <!-- Compensation -->
      <section class="score-breakdown__section">
        <div class="score-breakdown__row">
          <span class="text-body-2 font-weight-medium">Compensation</span>
          <v-chip size="small" variant="tonal" :color="score.compensation.score == null ? 'grey' : scoreColor(score.compensation.score)">
            {{ score.compensation.score == null ? 'Not scored' : `${score.compensation.score} / 100` }}
          </v-chip>
        </div>
        <dl class="score-breakdown__facts text-body-2">
          <template v-if="score.compensation.estimate != null">
            <dt>Estimated total</dt>
            <dd>{{ formatMoney(score.compensation.estimate) }} a year</dd>
          </template>
          <dt>Target</dt>
          <dd>{{ score.compensation.target != null ? formatMoney(score.compensation.target) : 'Not set' }}</dd>
          <dt>Floor</dt>
          <dd>
            {{ score.compensation.floor != null ? formatMoney(score.compensation.floor) : 'Not answered yet' }}
            <v-chip v-if="score.compensation.meetsFloor != null" size="x-small" variant="tonal" :color="score.compensation.meetsFloor ? 'success' : 'error'" class="ml-1">
              {{ score.compensation.meetsFloor ? 'Meets floor' : 'Below floor' }}
            </v-chip>
          </dd>
        </dl>
        <p class="text-body-2 score-breakdown__reasoning">
          {{ plainQuestionRefs(score.compensation.reasoning) }}
        </p>
      </section>

      <!-- Learned -->
      <section class="score-breakdown__section">
        <div class="score-breakdown__row">
          <span class="text-body-2 font-weight-medium">Learned from your decisions</span>
          <v-chip size="small" variant="tonal" :color="score.learned.total > 0 ? 'success' : score.learned.total < 0 ? 'error' : 'grey'">
            {{ signed(score.learned.total) }}
          </v-chip>
        </div>
        <p v-if="!score.learned.components.length" class="text-caption text-medium-emphasis">
          No learned rule applies to this job yet.
        </p>
        <ul v-else class="score-breakdown__learned text-body-2">
          <li v-for="(c, i) in score.learned.components" :key="i">
            <strong>{{ signed(c.points) }}</strong> {{ c.label }}<span v-if="c.detail" class="text-medium-emphasis">: {{ c.detail }}</span>
          </li>
        </ul>
      </section>

      <!-- Open preference questions -->
      <v-alert v-if="preferenceQuestions.length" type="info" variant="tonal" density="compact" class="mt-4">
        <div class="text-body-2 font-weight-medium mb-1">
          Answer {{ preferenceQuestions.length === 1 ? 'this question' : 'these questions' }} to complete the compensation score
        </div>
        <ul class="score-breakdown__questions text-body-2">
          <li v-for="q in preferenceQuestions" :key="q.id">
            {{ q.question }}
          </li>
        </ul>
        <v-btn to="/questions" size="small" variant="text" color="primary" class="mt-1 px-0" append-icon="mdi-arrow-right">
          Go to questions
        </v-btn>
      </v-alert>

      <!-- History -->
      <section v-if="history && history.length" class="score-breakdown__section">
        <div class="text-body-2 font-weight-medium mb-2">
          Score history
        </div>
        <div v-for="(h, i) in history" :key="i" class="score-breakdown__history text-caption">
          <span>{{ h.computedAt }}</span>
          <span class="text-medium-emphasis">{{ h.reason.replace('_', ' ') }}</span>
          <strong>{{ h.score }}</strong>
        </div>
      </section>
    </v-card-text>
  </v-card>
</template>

<style scoped lang="scss">
.score-breakdown {
  &__muted-icon {
    opacity: 0.3;
  }

  &__summary {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 8px;
  }

  &__section {
    margin-top: 20px;
    padding-top: 16px;
    border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  }

  &__row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 10px;
  }

  &__part {
    margin-bottom: 8px;
  }

  &__part-label {
    display: flex;
    justify-content: space-between;
    margin-bottom: 2px;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__reasoning {
    margin-top: 10px;
    line-height: 1.6;
  }

  &__chips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    margin-top: 8px;
  }

  &__chips-label {
    min-width: 52px;
  }

  &__facts {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 4px 12px;
    margin: 0;

    dt {
      color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    }

    dd {
      margin: 0;
    }
  }

  &__learned,
  &__questions {
    padding-left: 18px;
    margin: 0;
  }

  &__history {
    display: grid;
    grid-template-columns: 1fr auto auto;
    gap: 12px;
    padding: 2px 0;
  }
}
</style>

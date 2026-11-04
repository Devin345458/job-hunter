<script setup lang="ts">
import { plainQuestionRefs, plainScoreFigures, secondPerson } from '#shared/utils/plain-text'
import { questionsAbout, skillSets, softSkillsCount } from '#shared/utils/skill-sets'
import { PIPELINE_SCHEDULE_TEXT } from '#shared/utils/schedule'
import type { QuestionView, Requirement, ScoreBreakdown, SkillClaimSource } from '#shared/types/pipeline'
import { formatMoney, RECOMMENDATION_LABELS, scoreColor } from './format'
import { clockTime } from '~/composables/review/format'

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
  /** The posting requirements: the Has and Missing chips come from their statuses, so they agree with the requirement list. */
  requirements?: Requirement[]
}>()

const sets = computed(() => skillSets(props.requirements, props.score))
/** Soft skills that are not matched: one neutral line, never red chips, never in the Missing count. */
const softLine = computed(() => {
  const soft = sets.value.soft
  if (!soft.length) return null
  return { count: softSkillsCount(soft.length), names: soft.map(c => c.name).join('; '), asked: questionsAbout(soft, props.questions ?? []).length }
})

// A Missing chip is a button: tapping it opens the skill panel the page hosts.
const emit = defineEmits<{
  claim: [text: string, source: SkillClaimSource]
}>()

/** The chip's name without its closing reason, for screen readers. */
function chipName(s: string) {
  return s.replace(/\s*\([^()]*\)\s*$/, '').trim() || s
}

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
        Jobs are read and scored by the scheduled pipeline, which runs {{ PIPELINE_SCHEDULE_TEXT }}.
      </p>
    </v-card-text>

    <v-card-text v-else>
      <div class="score-breakdown__summary">
        <v-progress-circular :model-value="score.final" :size="88" :width="7" :color="scoreColor(score.final)" :aria-label="`Match score ${score.final} out of 100`">
          <span class="text-h5 font-weight-bold">{{ score.final }}</span>
        </v-progress-circular>
        <div>
          <div class="text-body-1 font-weight-medium">
            {{ RECOMMENDATION_LABELS[score.recommendation] }}
          </div>
          <div class="text-caption text-medium-emphasis">
            match score, out of 100
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
          <v-progress-linear :model-value="(p.value / p.max) * 100" :color="scoreColor((p.value / p.max) * 100)" height="6" rounded :aria-label="`${p.label}: ${p.value} of ${p.max}`" />
        </div>
        <p class="text-body-2 score-breakdown__reasoning">
          {{ secondPerson(plainScoreFigures(score.skills.reasoning)) }}
        </p>
        <!-- Matched is a count: every requirement is listed once, under Requirements, with its status. -->
        <p v-if="sets.matched.length" class="text-body-2 score-breakdown__matched">
          Matched {{ sets.matched.length }} of {{ sets.matched.length + sets.missing.length }}<span class="text-medium-emphasis">, each listed under Requirements</span>
        </p>
        <div v-if="sets.missing.length" class="score-breakdown__chips">
          <span class="text-caption text-medium-emphasis score-breakdown__chips-label">Missing {{ sets.missing.length }}</span>
          <v-chip
            v-for="c in sets.missing"
            :key="c.text"
            tag="button"
            type="button"
            size="x-small"
            variant="outlined"
            prepend-icon="mdi-minus"
            append-icon="mdi-chevron-right"
            class="score-breakdown__claim-chip"
            :title="c.text !== c.label ? c.text : undefined"
            :aria-label="`${chipName(c.label)}: say whether you have it`"
            @click="emit('claim', c.text, c.source)"
          >
            {{ c.label }}
          </v-chip>
        </div>
        <p v-if="sets.missing.length" class="text-caption text-medium-emphasis score-breakdown__hint">
          Tap a missing one you have to say so.
        </p>
        <p v-if="softLine" class="text-caption text-medium-emphasis score-breakdown__hint">
          {{ softLine.count }}, not counted as missing: {{ softLine.names }}.<template v-if="softLine.asked"> <NuxtLink to="/questions" class="score-breakdown__link">{{ softLine.asked === 1 ? 'Asked as a question' : 'Asked as questions' }}</NuxtLink></template>
        </p>
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
          {{ secondPerson(plainQuestionRefs(score.compensation.reasoning)) }}
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
        <v-btn to="/questions" size="small" variant="text" color="primary" class="mt-1 px-1 ms-n1" append-icon="mdi-arrow-right">
          Go to questions
        </v-btn>
      </v-alert>

      <!-- History -->
      <section v-if="history && history.length" class="score-breakdown__section">
        <div class="text-body-2 font-weight-medium mb-2">
          Score history
        </div>
        <div v-for="(h, i) in history" :key="i" class="score-breakdown__history text-caption">
          <span>{{ clockTime(h.computedAt) }}</span>
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

  &__matched {
    margin: 8px 0 0;
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

  // A long requirement ("Identity and authentication (OAuth/SAML/SCIM)") wraps inside its chip
  // instead of being cut off at the card's edge.
  &__chips :deep(.v-chip) {
    max-width: 100%;
    height: auto;
    min-height: 20px;
    padding-top: 2px;
    padding-bottom: 2px;
    white-space: normal;
  }

  &__claim-chip {
    cursor: pointer;
    text-align: left;
  }

  // The chip rule above (min-height 20px) outranks the global 44px phone target, so it is restated here.
  @media (max-width: 959.98px) {
    &__chips &__claim-chip {
      min-height: 44px;
    }
  }

  &__hint {
    margin: 6px 0 0;
  }

  &__link {
    font-weight: 600;
    color: rgb(var(--v-theme-primary));
    text-decoration: none;

    &:hover {
      text-decoration: underline;
    }
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

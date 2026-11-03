<script setup lang="ts">
import type { Requirement, ScoreBreakdown, SkillClaimSource } from '#shared/types/pipeline'
import { knowledgeSource } from '~/composables/review/format'
import { plainScoreFigures, secondPerson } from '#shared/utils/plain-text'
import { skillSets, softSkillsCount } from '#shared/utils/skill-sets'
import { isProfileFact } from '#shared/utils/requirement-kinds'

// Skills fit: matched and missing skills first, then each posting requirement with what the
// knowledge base says about it. The chips come from the requirements (skillSets), so they never
// contradict the checklist. Every Missing chip and every requirement that is not Have is a
// button: tapping it opens the skill panel (SkillsClaimDialog, hosted by the card) to say you have it.
const props = defineProps<{
  score: ScoreBreakdown | null
  requirements: Requirement[]
  /** Desktop shows the Missing chips under the score instead, so this section keeps Matched and the checklist. */
  hideMissing?: boolean
}>()

const emit = defineEmits<{
  claim: [text: string, source: SkillClaimSource]
}>()

const STATUS: Record<Requirement['status'], { label: string; icon: string; color: string }> = {
  have: { label: 'Have', icon: 'mdi-check', color: 'success' },
  partial: { label: 'Partly', icon: 'mdi-circle-half-full', color: 'warning' },
  lack: { label: 'Missing', icon: 'mdi-close', color: 'error' },
  unknown: { label: 'Not in profile', icon: 'mdi-help', color: 'secondary' },
}

/** "Python proficiency (knowledge base explicitly states ...)" is named Python proficiency on screen readers. */
function chipName(s: string) {
  return s.replace(/\s*\([^()]*\)\s*$/, '').trim() || s
}

const sorted = computed(() => [...props.requirements].sort((a, b) => Number(b.mustHave) - Number(a.mustHave)))
const sets = computed(() => skillSets(props.requirements, props.score))
/** Work authorization, location, and degree lines are profile facts: listed, but not a skill to claim. */
const tappable = (r: Requirement) => r.status !== 'have' && !isProfileFact(r.text)
</script>

<template>
  <div class="skills">
    <p v-if="score?.skills.reasoning" class="skills__reason">{{ secondPerson(plainScoreFigures(score.skills.reasoning)) }}</p>

    <div v-if="score || sets.matched.length || sets.missing.length || sets.soft.length" class="skills__sets">
      <div class="skills__set">
        <div class="skills__set-label">Matched <span class="tabular">{{ sets.matched.length }}</span></div>
        <div class="skills__chips">
          <v-chip v-for="c in sets.matched" :key="c.text" size="small" color="success" variant="tonal" :prepend-icon="c.status === 'partial' ? 'mdi-circle-half-full' : 'mdi-check'" :title="c.text !== c.label ? c.text : undefined">{{ c.label }}</v-chip>
          <span v-if="!sets.matched.length" class="skills__none">None</span>
        </div>
      </div>
      <div v-if="!hideMissing" class="skills__set">
        <div class="skills__set-label">Missing <span class="tabular">{{ sets.missing.length }}</span></div>
        <div class="skills__chips">
          <v-chip
            v-for="c in sets.missing"
            :key="c.text"
            tag="button"
            type="button"
            size="small"
            color="error"
            variant="tonal"
            prepend-icon="mdi-minus"
            append-icon="mdi-chevron-right"
            class="skills__claim-chip"
            :title="c.text !== c.label ? c.text : undefined"
            :aria-label="`${chipName(c.label)}: say whether you have it`"
            @click="emit('claim', c.text, c.source)"
          >
            {{ c.label }}
          </v-chip>
          <span v-if="!sets.missing.length" class="skills__none">Nothing missing</span>
        </div>
        <p v-if="sets.missing.length" class="skills__hint">Tap one you have to say so.</p>
        <p v-if="sets.soft.length" class="skills__hint">{{ softSkillsCount(sets.soft.length) }}, not counted as missing: {{ sets.soft.map(c => c.name).join('; ') }}.</p>
      </div>
    </div>

    <ul v-if="sorted.length" class="skills__reqs" aria-label="Posting requirements">
      <li v-for="(r, i) in sorted" :key="i" class="skills__req">
        <component
          :is="tappable(r) ? 'button' : 'div'"
          :type="tappable(r) ? 'button' : undefined"
          class="skills__req-row"
          :class="{ 'skills__req-row--tap': tappable(r) }"
          :aria-label="tappable(r) ? `${r.text}. ${STATUS[r.status].label}. Say whether you have it` : undefined"
          @click="tappable(r) && emit('claim', r.text, 'requirement')"
        >
          <v-icon :icon="isProfileFact(r.text) ? 'mdi-card-account-details-outline' : STATUS[r.status].icon" :color="isProfileFact(r.text) ? 'secondary' : STATUS[r.status].color" size="16" class="skills__req-icon" />
          <span class="skills__req-body">
            <span class="skills__req-text">{{ r.text }}</span>
            <span v-if="isProfileFact(r.text)" class="skills__req-meta">{{ r.mustHave ? 'Must have' : 'Nice to have' }} · Profile fact, not a skill</span>
            <span v-else class="skills__req-meta">
              {{ r.mustHave ? 'Must have' : 'Nice to have' }} · {{ STATUS[r.status].label }}{{ r.evidence ? ` · knowledge base: ${knowledgeSource(r.evidence)}` : '' }}
            </span>
          </span>
          <v-icon v-if="tappable(r)" icon="mdi-chevron-right" size="18" class="skills__req-go" />
        </component>
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

    // A long skill ("Identity and access management concepts (SSO, SAML, OIDC, SCIM, passkeys)")
    // wraps inside its chip instead of pushing the card past a phone's edge.
    :deep(.v-chip) {
      max-width: 100%;
      height: auto;
      min-height: 24px;
      padding-top: 2px;
      padding-bottom: 2px;
      white-space: normal;
    }
  }

  // A Missing chip is a button that opens the skill panel. The global phone rule gives it 44px;
  // the chevron says it opens something.
  &__claim-chip {
    cursor: pointer;
    text-align: left;

    :deep(.v-chip__append) {
      margin-inline-start: 4px;
      opacity: 0.7;
    }
  }

  // The chip rule above (min-height 24px) outranks the global 44px phone target, so it is restated here.
  @media (max-width: 959.98px) {
    &__chips &__claim-chip {
      min-height: 44px;
    }
  }

  &__hint {
    margin: 6px 0 0;
    font-size: 0.75rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
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
    border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  }

  &__req-row {
    display: flex;
    gap: 10px;
    width: 100%;
    padding: 8px 0;
    text-align: left;
    color: inherit;
    font: inherit;
    background: none;
    border: 0;
  }

  // A requirement that is not Have opens the skill panel: a full-width row, 44px or taller.
  &__req-row--tap {
    min-height: 44px;
    margin: 0 -8px;
    padding: 8px;
    width: calc(100% + 16px);
    border-radius: 8px;
    cursor: pointer;

    &:hover {
      background: rgba(var(--v-theme-on-surface), 0.05);
    }

    &:focus-visible {
      outline: 2px solid rgb(var(--v-theme-primary));
      outline-offset: -2px;
    }
  }

  &__req-go {
    margin-left: auto;
    align-self: center;
    flex-shrink: 0;
    opacity: 0.6;
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
    overflow-wrap: anywhere;
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

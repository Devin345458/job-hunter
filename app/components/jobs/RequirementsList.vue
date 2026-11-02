<script setup lang="ts">
import type { Requirement, SkillClaimSource } from '#shared/types/pipeline'
import { plainKnowledgeRefs } from '#shared/utils/plain-text'
import { knowledgeRef } from '~/composables/review/format'

// The posting's requirements, judged against the knowledge base. A requirement that is not Have
// is a button: tapping it opens the skill panel the page hosts, to say whether you have it.
const props = defineProps<{
  requirements: Requirement[]
}>()

const emit = defineEmits<{
  claim: [text: string, source: SkillClaimSource]
}>()

const STATUS = {
  have: { label: 'Have', color: 'success', icon: 'mdi-check-circle-outline' },
  partial: { label: 'Partly', color: 'warning', icon: 'mdi-circle-half-full' },
  lack: { label: 'Missing', color: 'error', icon: 'mdi-close-circle-outline' },
  unknown: { label: 'Not in profile', color: 'grey', icon: 'mdi-help-circle-outline' },
} as const

/**
 * The entry a status cites, in words: "skill/Sentry" is "your Sentry entry", "profile/Professional
 * Summary" is "your Professional Summary". A key may hold commas (an answered experience question
 * names the whole requirement), so a bare key is named whole rather than parsed as a sentence.
 */
function evidenceText(evidence: string): string {
  const name = knowledgeRef(evidence)
  if (!name || name === evidence.trim() || /[/:]/.test(name)) return plainKnowledgeRefs(evidence)
  return /^(?:profile|personal|preferences?)\s*[/:]/i.test(evidence) ? `your ${name}` : `your ${name} entry`
}

const mustHave = computed(() => props.requirements.filter(r => r.mustHave))
const niceToHave = computed(() => props.requirements.filter(r => !r.mustHave))
const counts = computed(() => {
  const out = { have: 0, partial: 0, lack: 0, unknown: 0 }
  for (const r of mustHave.value) out[r.status]++
  return out
})
</script>

<template>
  <v-card variant="outlined" class="requirements">
    <v-card-item>
      <v-card-title class="text-subtitle-1 font-weight-medium">
        Requirements
      </v-card-title>
      <v-card-subtitle v-if="mustHave.length" class="text-caption requirements__subtitle">
        Must-haves: {{ counts.have }} have, {{ counts.partial }} partly, {{ counts.lack }} missing, {{ counts.unknown }} not in your profile
      </v-card-subtitle>
    </v-card-item>
    <v-card-text>
      <template v-for="group in [{ title: 'Must have', items: mustHave }, { title: 'Nice to have', items: niceToHave }]" :key="group.title">
        <div v-if="group.items.length" class="requirements__group">
          <div class="text-body-2 font-weight-medium mb-2">
            {{ group.title }}
          </div>
          <component
            :is="r.status === 'have' ? 'div' : 'button'"
            v-for="(r, i) in group.items"
            :key="i"
            :type="r.status === 'have' ? undefined : 'button'"
            class="requirements__item"
            :class="{ 'requirements__item--tap': r.status !== 'have' }"
            :aria-label="r.status === 'have' ? undefined : `${r.text}. ${STATUS[r.status].label}. Say whether you have it`"
            @click="r.status !== 'have' && emit('claim', r.text, 'requirement')"
          >
            <v-icon :icon="STATUS[r.status].icon" :color="STATUS[r.status].color" size="18" class="requirements__icon" />
            <span class="requirements__body">
              <span class="d-block text-body-2">
                {{ r.text }}
              </span>
              <span class="d-block text-caption text-medium-emphasis">
                {{ STATUS[r.status].label }}{{ r.evidence ? `, from ${evidenceText(r.evidence)}` : '' }}
              </span>
            </span>
            <v-icon v-if="r.status !== 'have'" icon="mdi-chevron-right" size="18" class="requirements__go" />
          </component>
        </div>
      </template>
      <p class="text-caption text-medium-emphasis mt-2">
        Judged only against your knowledge base. "Not in profile" means it does not say either way. Tap one that is not Have to say whether you have it.
      </p>
    </v-card-text>
  </v-card>
</template>

<style scoped lang="scss">
.requirements {
  &__subtitle {
    white-space: normal;
  }

  &__group + &__group {
    margin-top: 16px;
  }

  &__item {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    width: 100%;
    padding: 6px 0;
    text-align: left;
    color: inherit;
    font: inherit;
    background: none;
    border: 0;
  }

  // Not Have: a full-width button row, 44px or taller, that opens the skill panel.
  &__item--tap {
    min-height: 44px;
    margin: 0 -8px;
    padding: 6px 8px;
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

  &__go {
    margin-left: auto;
    align-self: center;
    flex-shrink: 0;
    opacity: 0.6;
  }

  &__icon {
    margin-top: 2px;
    flex-shrink: 0;
  }

  &__body {
    min-width: 0;
    overflow-wrap: anywhere;
  }
}
</style>

<script setup lang="ts">
import type { AnswerSource, FormAnswer, FormSnapshot } from '#shared/types/pipeline'
import { answerText, clockTime, hostOf } from '~/composables/review/format'

// The employer form as the pipeline filled it: every field's value, where the value came
// from, and how sure the pipeline is, beside a screenshot of the filled page. In copy mode
// (submit by hand) each value gets a copy button.
const props = defineProps<{
  answers: FormAnswer[]
  snapshot: FormSnapshot | null
  screenshotUrl: string | null
  filledAt: string | null
  formError: string | null
  copyMode?: boolean
}>()

const SOURCE: Record<AnswerSource, string> = {
  knowledge: 'Knowledge base',
  resume: 'Resume',
  cover_letter: 'Cover letter',
  generated: 'Written by the pipeline',
  question: 'Your answer',
  eeo_decline: 'Declined (EEO)',
  skipped: 'Left blank',
}

const CONF: Record<FormAnswer['confidence'], { label: string; color: string }> = {
  high: { label: 'Sure', color: 'success' },
  medium: { label: 'Check', color: 'warning' },
  low: { label: 'Unsure', color: 'error' },
}

const shotOpen = ref(false)
const copiedId = ref<string | null>(null)
const copyError = ref<string | null>(null)

const fieldsById = computed(() => new Map((props.snapshot?.fields ?? []).map(f => [f.id, f])))

async function copy(a: FormAnswer) {
  copyError.value = null
  try {
    await navigator.clipboard.writeText(answerText(a.value))
    copiedId.value = a.fieldId
    setTimeout(() => { if (copiedId.value === a.fieldId) copiedId.value = null }, 1600)
  }
  catch {
    copyError.value = 'The browser blocked the clipboard. Select the text and copy it instead.'
  }
}

function isLong(a: FormAnswer) {
  return answerText(a.value).length > 140
}
</script>

<template>
  <div class="fa">
    <div v-if="formError" class="fa__error" role="alert">
      <v-icon icon="mdi-alert-outline" size="16" />
      {{ formError }}
    </div>

    <div v-if="snapshot?.blockers?.length" class="fa__blockers">
      <div v-for="b in snapshot.blockers" :key="b" class="fa__blocker">
        <v-icon icon="mdi-lock-outline" size="16" /> {{ b }}
      </div>
    </div>

    <div class="fa__layout" :class="{ 'fa__layout--shot': screenshotUrl }">
      <ul class="fa__list">
        <li v-for="a in answers" :key="a.fieldId" class="fa__row">
          <div class="fa__label">
            {{ a.label }}
            <span v-if="fieldsById.get(a.fieldId)?.required" class="fa__req" aria-label="required">*</span>
          </div>
          <div class="fa__value" :class="{ 'fa__value--empty': !answerText(a.value), 'fa__value--long': isLong(a) }">
            {{ answerText(a.value) || (a.needsQuestionId ? 'Waiting on your answer above' : 'Blank') }}
          </div>
          <div class="fa__meta">
            <span>{{ SOURCE[a.source] ?? a.source }}<template v-if="a.sourceDetail && a.source === 'knowledge'"> ({{ a.sourceDetail.replace(':', ': ') }})</template></span>
            <span class="fa__conf" :class="`text-${CONF[a.confidence].color}`">{{ CONF[a.confidence].label }}</span>
            <span v-if="a.fillError" class="text-error">Fill error: {{ a.fillError }}</span>
          </div>
          <v-btn
            v-if="copyMode && answerText(a.value)"
            class="fa__copy"
            variant="tonal"
            size="small"
            height="44"
            :prepend-icon="copiedId === a.fieldId ? 'mdi-check' : 'mdi-content-copy'"
            :aria-label="`Copy ${a.label}`"
            @click="copy(a)"
          >
            {{ copiedId === a.fieldId ? 'Copied' : 'Copy' }}
          </v-btn>
        </li>
      </ul>

      <figure v-if="screenshotUrl" class="fa__shot">
        <button type="button" class="fa__shot-btn" aria-label="Open the form screenshot full size" @click="shotOpen = true">
          <img :src="screenshotUrl" alt="Screenshot of the filled employer form" loading="lazy">
        </button>
        <figcaption>
          Filled {{ clockTime(filledAt) }}<template v-if="snapshot"> on {{ hostOf(snapshot.finalUrl || snapshot.url) }}</template>. Not submitted.
        </figcaption>
      </figure>
    </div>

    <p v-if="copyError" class="fa__copy-error" role="alert">{{ copyError }}</p>

    <v-dialog v-model="shotOpen" max-width="960" scrollable>
      <v-card>
        <div class="fa__dialog-head">
          <span>Filled form</span>
          <v-btn icon="mdi-close" variant="text" aria-label="Close" @click="shotOpen = false" />
        </div>
        <v-card-text class="pa-0">
          <img :src="screenshotUrl ?? undefined" alt="Screenshot of the filled employer form" class="fa__full">
        </v-card-text>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped lang="scss">
.fa {
  &__error,
  &__blocker {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.8125rem;
    padding: 8px 12px;
    border-radius: 6px;
    margin-bottom: 8px;
  }

  &__error {
    color: rgb(var(--v-theme-error));
    background: rgba(var(--v-theme-error), 0.08);
  }

  &__blocker {
    color: rgb(var(--v-theme-warning));
    background: rgba(var(--v-theme-warning), 0.08);
  }

  &__layout {
    display: grid;
    gap: 16px;

    &--shot {
      @media (min-width: 1200px) {
        grid-template-columns: minmax(0, 1fr) 220px;
      }
    }
  }

  &__list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  &__row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    column-gap: 12px;
    padding: 10px 0;
    border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));

    &:first-child { border-top: 0; padding-top: 0; }
  }

  &__label {
    grid-column: 1;
    font-size: 0.75rem;
    font-weight: 600;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__req {
    color: rgb(var(--v-theme-error));
  }

  &__value {
    grid-column: 1;
    font-size: 0.875rem;
    margin-top: 2px;
    overflow-wrap: anywhere;

    &--empty {
      color: rgba(var(--v-theme-on-surface), var(--v-disabled-opacity));
    }

    &--long {
      white-space: pre-line;
      max-height: 9.5em;
      overflow-y: auto;
      padding-right: 4px;
    }
  }

  &__meta {
    grid-column: 1;
    display: flex;
    flex-wrap: wrap;
    gap: 2px 12px;
    margin-top: 3px;
    font-size: 0.75rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__conf {
    font-weight: 600;
  }

  &__copy {
    grid-column: 2;
    grid-row: 1 / span 3;
    align-self: center;
  }

  &__shot {
    margin: 0;

    figcaption {
      margin-top: 6px;
      font-size: 0.75rem;
      color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    }
  }

  &__shot-btn {
    display: block;
    width: 100%;
    max-height: 320px;
    overflow: hidden;
    border-radius: 8px;
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    cursor: zoom-in;

    img {
      display: block;
      width: 100%;
      height: auto;
      outline: 1px solid rgba(var(--v-theme-on-surface), 0.1);
      outline-offset: -1px;
    }

    @media (max-width: 1199.98px) {
      max-height: 200px;
    }
  }

  &__copy-error {
    font-size: 0.8125rem;
    color: rgb(var(--v-theme-error));
    margin: 8px 0 0;
  }

  &__dialog-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 4px 4px 16px;
    font-weight: 600;
  }

  &__full {
    display: block;
    width: 100%;
    height: auto;
  }
}
</style>

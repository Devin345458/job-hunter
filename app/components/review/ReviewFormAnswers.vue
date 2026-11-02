<script setup lang="ts">
import { useDisplay } from 'vuetify'
import type { FormAnswer, FormSnapshot } from '#shared/types/pipeline'
import { answerSourceText, answerText, blockerText, clockTime, hostOf } from '~/composables/review/format'
import { plainError } from '#shared/utils/plain-text'
import { SENT_STATUSES } from '#shared/utils/outcomes'

// The employer form as the pipeline filled it: every field's value, where the value came
// from, and how sure the pipeline is, beside a screenshot of the filled page. Every filled value
// has a Copy button, and Copy all answers takes the lot, because approve on a real employer
// means Devin pastes them into the employer's form himself.
const props = defineProps<{
  answers: FormAnswer[]
  snapshot: FormSnapshot | null
  screenshotUrl: string | null
  filledAt: string | null
  formError: string | null
  /** Where the question a field waits on sits on this page ("in Answer first, above"). */
  questionHint?: (questionId: number) => string
  /** The application's status, so the screenshot caption says whether it was submitted. Without it the caption says "Not submitted." */
  status?: string | null
  /** When the submit happened, for a submitted application. */
  submittedAt?: string | null
  /** How it was submitted: by the pipeline, or by hand on the employer's site. */
  submitMethod?: 'automated' | 'manual' | null
}>()

const SENT: readonly string[] = SENT_STATUSES
/** The screenshot caption's last sentence, following the application's status. */
const submitState = computed(() => {
  const s = props.status
  if (!s) return 'Not submitted.'
  if (SENT.includes(s) && props.submitMethod === 'manual') return 'You submitted it by hand.'
  if (SENT.includes(s)) return props.submittedAt ? `Submitted ${clockTime(props.submittedAt)}.` : 'Submitted.'
  if (['approved', 'publishing', 'submitting'].includes(s)) return 'Approved and being submitted now.'
  if (s === 'submit_failed') return 'The submit failed.'
  if (s === 'needs_manual') return 'Not submitted by the pipeline. It is yours to submit by hand.'
  if (s === 'declined') return 'Not submitted. You rejected it.'
  return 'Not submitted.'
})

/**
 * When the resume and cover letter files reach the employer, following the application's status.
 * The fill stored "attached only after you approve", which stops being true at approve. Null
 * while that stored wording is still right.
 */
const attachState = computed<string | null>(() => {
  const s = props.status
  if (!s) return null
  if (SENT.includes(s)) return props.submitMethod === 'manual' ? 'for you to attach on the employer\'s form' : 'attached with the submission'
  if (s === 'needs_manual') return 'for you to attach on the employer\'s form'
  if (['approved', 'publishing', 'submitting'].includes(s)) return 'attached as the submission goes out'
  return null
})

/** Where an answer came from, with a file field's attachment said for the application's status. */
function sourceText(a: FormAnswer): string {
  const text = answerSourceText(a)
  if (!attachState.value || (a.source !== 'resume' && a.source !== 'cover_letter')) return text
  return text.replace(/attached only after you approve/i, attachState.value)
}

const CONF: Record<FormAnswer['confidence'], { label: string; color: string }> = {
  high: { label: 'Sure', color: 'success' },
  medium: { label: 'Check', color: 'warning' },
  low: { label: 'Unsure', color: 'error' },
}

// A failed preparation stops before the form step; its reason is shown with the preparation.
const errorText = computed(() => {
  if (!props.formError) return ''
  if (/^prepare_failed/.test(props.formError)) return 'Not filled: preparation failed before the form step.'
  return plainError(props.formError)
})

/** Files are never attached in the dry run; that is expected, not an error. */
function isDryRunNote(a: FormAnswer) {
  return !!a.fillError && /not attached in the dry run/i.test(a.fillError)
}

function waitingText(a: FormAnswer) {
  const where = a.needsQuestionId && props.questionHint ? props.questionHint(a.needsQuestionId) : ''
  return where ? `Waiting on your answer ${where}` : 'Waiting on your answer'
}

// Full size: the whole page width in a dialog on a wide screen. On a phone the dialog fills the
// screen and the screenshot keeps its real width, so the text stays readable and pans.
const { smAndDown } = useDisplay()
const fitWidth = ref(false)
const shotOpen = ref(false)
// Long answers are clamped to a few lines; tapping "Show all" opens one in full.
const expanded = ref<Set<string>>(new Set())
function toggle(id: string) {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}
const fieldsById = computed(() => new Map((props.snapshot?.fields ?? []).map(f => [f.id, f])))

/** A filled answer that pastes: a file field's value is only the attachment's name. */
function copyable(a: FormAnswer) {
  return !!answerText(a.value) && fieldsById.value.get(a.fieldId)?.type !== 'file'
}

const filled = computed(() => props.answers.filter(copyable))

/**
 * Every filled answer as "Label: value", one per line, in form order. A value with line breaks
 * keeps them and sits under its label with a blank line around it, so it pastes as written.
 */
function allAnswersText(): string {
  const parts = filled.value.map((a) => {
    const value = answerText(a.value)
    return value.includes('\n') ? `${a.label}:\n${value}` : `${a.label}: ${value}`
  })
  return parts.reduce((out, part, i) => {
    if (i === 0) return part
    const spaced = part.includes('\n') || parts[i - 1]!.includes('\n')
    return `${out}${spaced ? '\n\n' : '\n'}${part}`
  }, '')
}

function isLong(a: FormAnswer) {
  return answerText(a.value).length > 140
}
</script>

<template>
  <div class="fa">
    <div v-if="errorText" class="fa__error" role="alert">
      <v-icon icon="mdi-alert-outline" size="16" />
      <span class="fa__error-text">{{ errorText }}</span>
    </div>

    <div v-if="snapshot?.blockers?.length" class="fa__blockers">
      <div v-for="b in snapshot.blockers" :key="b" class="fa__blocker">
        <v-icon icon="mdi-lock-outline" size="16" />
        <span class="fa__error-text">{{ blockerText(b) }}</span>
      </div>
    </div>

    <div v-if="filled.length" class="fa__tools">
      <ReviewCopyButton
        :text="allAnswersText"
        variant="tonal"
        :label="`Copy all answers (${filled.length})`"
        aria-label="Copy all filled answers, label then value, one per line"
      />
    </div>

    <div class="fa__layout" :class="{ 'fa__layout--shot': screenshotUrl }">
      <ul class="fa__list">
        <li v-for="a in answers" :key="a.fieldId" class="fa__row">
          <div class="fa__label">
            {{ a.label }}
            <span v-if="fieldsById.get(a.fieldId)?.required" class="fa__req" aria-label="required">*</span>
          </div>
          <div class="fa__value" :class="{ 'fa__value--empty': !answerText(a.value), 'fa__value--long': isLong(a), 'fa__value--open': expanded.has(a.fieldId) }">
            {{ answerText(a.value) || (a.needsQuestionId ? waitingText(a) : 'Blank') }}
          </div>
          <button v-if="isLong(a)" type="button" class="fa__more" @click="toggle(a.fieldId)">
            {{ expanded.has(a.fieldId) ? 'Show less' : 'Show all' }}
          </button>
          <div class="fa__meta">
            <span>{{ sourceText(a) }}</span>
            <span class="fa__conf" :class="`text-${CONF[a.confidence].color}`">{{ CONF[a.confidence].label }}</span>
            <!-- After approve the source line says when the file is attached, so the dry-run note would repeat or contradict it. -->
            <span v-if="isDryRunNote(a) && !attachState">Attached when you approve</span>
            <span v-else-if="a.fillError" class="text-error">Not filled: {{ plainError(a.fillError) }}</span>
          </div>
          <ReviewCopyButton
            v-if="copyable(a)"
            class="fa__copy"
            :text="answerText(a.value)"
            :aria-label="`Copy ${a.label}`"
          />
        </li>
      </ul>

      <figure v-if="screenshotUrl" class="fa__shot">
        <button type="button" class="fa__shot-btn" aria-label="Open the form screenshot full size" @click="shotOpen = true">
          <img :src="screenshotUrl" alt="Screenshot of the filled employer form" loading="lazy">
        </button>
        <figcaption>
          Filled {{ clockTime(filledAt) }}{{ snapshot ? ` on ${hostOf(snapshot.finalUrl || snapshot.url)}` : '' }}. {{ submitState }}
        </figcaption>
      </figure>
    </div>

    <v-dialog v-model="shotOpen" max-width="960" :fullscreen="smAndDown" scrollable>
      <v-card>
        <div class="fa__dialog-head">
          <span>Filled form</span>
          <div class="fa__dialog-actions">
            <v-btn
              v-if="smAndDown"
              variant="text"
              height="44"
              :prepend-icon="fitWidth ? 'mdi-magnify-plus-outline' : 'mdi-fit-to-page-outline'"
              @click="fitWidth = !fitWidth"
            >
              {{ fitWidth ? 'Actual size' : 'Fit width' }}
            </v-btn>
            <v-btn icon="mdi-close" variant="text" width="44" height="44" aria-label="Close" @click="shotOpen = false" />
          </div>
        </div>
        <v-card-text class="pa-0 fa__pan" :class="{ 'fa__pan--actual': smAndDown && !fitWidth }">
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
    align-items: flex-start;
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
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 6;
      line-clamp: 6;
      overflow: hidden;
    }

    &--open {
      display: block;
      -webkit-line-clamp: unset;
      line-clamp: unset;
      overflow: visible;
    }
  }

  &__more {
    grid-column: 1;
    justify-self: start;
    min-height: 44px;
    padding: 0;
    background: none;
    border: 0;
    color: rgb(var(--v-theme-primary));
    font: inherit;
    font-size: 0.8125rem;
    font-weight: 600;
    cursor: pointer;
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
    min-height: 44px;
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

  &__tools {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 8px;
  }

  &__dialog-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 4px 4px 16px;
    font-weight: 600;
  }

  &__dialog-actions {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  &__error-text {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  &__full {
    display: block;
    width: 100%;
    height: auto;
  }

  // Phone, actual size: the screenshot keeps its own width and the card scrolls both ways.
  &__pan--actual {
    overflow: auto !important;
    -webkit-overflow-scrolling: touch;
  }

  &__pan--actual &__full {
    width: auto;
    max-width: none;
  }
}
</style>

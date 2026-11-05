<script setup lang="ts">
import type { FormAnswer, FormSnapshot } from '#shared/types/pipeline'
import { answerSourceText, answerText, blockerText } from '~/composables/review/format'
import { cleanFieldLabel, plainError } from '#shared/utils/plain-text'

// Stage 1 (Decide): what reading the employer form found, before anything is written. Fields the
// profile already fills, fields that wait on one of Devin's answers, and fields Claude writes only
// after Apply. Nothing here was typed into the employer's form.
const props = defineProps<{
  answers: FormAnswer[]
  snapshot: FormSnapshot | null
  /** Why the form cannot be filled here (account, no link, closed posting), as stored. */
  formError: string | null
  /** The status detail while the read is still running. */
  detail: string | null
}>()

/** The resume and cover letter uploads: their files are written at Apply and attached only after Approve. */
const isDocument = (a: FormAnswer) => a.source === 'resume' || a.source === 'cover_letter'
const filled = computed(() => props.answers.filter(a => !!answerText(a.value) && !isDocument(a)))
const asks = computed(() => props.answers.filter(a => typeof a.needsQuestionId === 'number' && !answerText(a.value)))
const later = computed(() => props.answers.filter(a => a.atApply || isDocument(a)))
const blank = computed(() => props.answers.filter(a => !answerText(a.value) && !a.atApply && typeof a.needsQuestionId !== 'number'))
const fieldsById = computed(() => new Map((props.snapshot?.fields ?? []).map(f => [f.id, f])))
const required = (a: FormAnswer) => fieldsById.value.get(a.fieldId)?.required !== false
/** The form's own text for a field that is not a document upload (FormField.description). */
const descriptionOf = (a: FormAnswer) => isDocument(a) ? null : fieldsById.value.get(a.fieldId)?.description ?? null
const blockers = computed(() => (props.snapshot?.blockers ?? []).map(blockerText))
const errorText = computed(() => plainError(props.formError))
</script>

<template>
  <div class="frd">
    <p v-if="errorText" class="frd__note frd__note--warning">
      <v-icon icon="mdi-hand-pointing-right" size="16" />
      <span>{{ errorText }}.</span>
    </p>
    <p v-else-if="!snapshot" class="frd__note">
      <v-progress-circular v-if="detail" indeterminate size="14" width="2" />
      <span>{{ detail || 'The form has not been read yet. The next run reads it.' }}</span>
    </p>
    <template v-else>
      <ul v-if="blockers.length" class="frd__blockers">
        <li v-for="b in blockers" :key="b"><v-icon icon="mdi-alert-outline" size="15" /> {{ b }}</li>
      </ul>

      <div v-if="asks.length" class="frd__group">
        <h3 class="frd__h">Waiting on your answer ({{ asks.length }})</h3>
        <ul class="frd__list">
          <li v-for="a in asks" :key="a.fieldId" class="frd__row">
            <span class="frd__label">{{ cleanFieldLabel(a.label) }}</span>
            <span class="frd__value frd__value--muted">{{ required(a) ? 'Required. ' : 'Optional. ' }}The question is above.</span>
          </li>
        </ul>
      </div>

      <div v-if="later.length" class="frd__group">
        <h3 class="frd__h">Written when you tap Apply ({{ later.length }})</h3>
        <p class="frd__help">These need the resume and letter Apply writes, so nothing is written for them unless you apply.</p>
        <ul class="frd__list">
          <li v-for="a in later" :key="a.fieldId" class="frd__row">
            <span class="frd__label">
              {{ cleanFieldLabel(a.label) }}
              <!-- The form's own text for the field: "Tell us more" says nothing without it. -->
              <span v-if="descriptionOf(a)" class="frd__desc" :title="descriptionOf(a) ?? undefined">{{ descriptionOf(a) }}</span>
            </span>
            <span class="frd__value frd__value--muted">{{ isDocument(a) ? `${a.source === 'resume' ? 'Your tailored resume' : 'Your cover letter'}, attached only after you approve` : required(a) ? 'Required' : 'Optional' }}</span>
          </li>
        </ul>
      </div>

      <div v-if="filled.length" class="frd__group">
        <h3 class="frd__h">Filled from your profile ({{ filled.length }})</h3>
        <ul class="frd__list">
          <li v-for="a in filled" :key="a.fieldId" class="frd__row">
            <span class="frd__label">{{ cleanFieldLabel(a.label) }}</span>
            <span class="frd__value">{{ answerText(a.value) }} <span class="frd__source">{{ answerSourceText(a) }}</span></span>
          </li>
        </ul>
      </div>

      <div v-if="blank.length" class="frd__group">
        <h3 class="frd__h">Left blank ({{ blank.length }})</h3>
        <ul class="frd__list">
          <li v-for="a in blank" :key="a.fieldId" class="frd__row">
            <span class="frd__label">{{ cleanFieldLabel(a.label) }}</span>
            <span class="frd__value frd__value--muted">{{ answerSourceText(a) }}</span>
          </li>
        </ul>
      </div>
    </template>
  </div>
</template>

<style scoped lang="scss">
.frd {
  font-size: 0.875rem;

  &__note {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));

    &--warning {
      color: rgb(var(--v-theme-warning));
    }
  }

  &__blockers {
    list-style: none;
    margin: 0 0 12px;
    padding: 0;
    color: rgb(var(--v-theme-warning));

    li + li {
      margin-top: 4px;
    }
  }

  &__group + &__group {
    margin-top: 16px;
  }

  &__h {
    font-size: 0.8125rem;
    font-weight: 700;
    margin: 0 0 6px;
  }

  &__help {
    margin: -2px 0 6px;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  &__row {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
    gap: 12px;
    padding: 5px 0;
    border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  }

  &__label {
    overflow-wrap: anywhere;
  }

  &__desc {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    margin-top: 2px;
    font-size: 0.75rem;
    line-height: 1.4;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__value {
    overflow-wrap: anywhere;

    &--muted {
      color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    }
  }

  &__source {
    display: block;
    font-size: 0.75rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }
}
</style>

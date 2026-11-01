<script setup lang="ts">
import type { QuestionView } from '#shared/types/pipeline'

// Open questions answered in place. Yes or no is one tap; text, numbers, and choices take one
// short field and Save. Answers go through PATCH /api/questions/:id via the parent.
const props = defineProps<{
  questions: QuestionView[]
  /** Question id currently saving. */
  savingId: number | null
  /** Shown under the list while the server re-derives the form answers. */
  refreshing?: boolean
}>()

const emit = defineEmits<{
  answer: [questionId: number, answer: string]
  skip: [questionId: number]
}>()

const drafts = reactive<Record<number, string>>({})

function submitText(q: QuestionView) {
  const value = (drafts[q.id] ?? '').trim()
  if (!value) return
  emit('answer', q.id, value)
}

function inputMode(q: QuestionView) {
  return q.answerType === 'number' ? 'decimal' : 'text'
}
</script>

<template>
  <div class="qs">
    <article v-for="q in questions" :key="q.id" class="qs__item" :class="{ 'qs__item--blocking': q.blocking }">
      <div class="qs__top">
        <span v-if="q.blocking" class="qs__flag">Blocks approve</span>
        <span v-else class="qs__flag qs__flag--soft">Optional</span>
      </div>
      <h4 class="qs__question">{{ q.question }}</h4>
      <p v-if="q.context" class="qs__context">{{ q.context }}</p>

      <div v-if="q.answerType === 'yes_no'" class="qs__actions">
        <v-btn
          variant="tonal"
          :disabled="savingId !== null"
          min-width="96"
          height="44"
          prepend-icon="mdi-check"
          @click="emit('answer', q.id, 'Yes')"
        >
          Yes
        </v-btn>
        <v-btn
          variant="tonal"
          :disabled="savingId !== null"
          min-width="96"
          height="44"
          prepend-icon="mdi-close"
          @click="emit('answer', q.id, 'No')"
        >
          No
        </v-btn>
        <v-btn v-if="!q.blocking" variant="text" height="44" :disabled="savingId !== null" @click="emit('skip', q.id)">Skip</v-btn>
      </div>

      <div v-else-if="q.answerType === 'choice' && q.choices?.length" class="qs__actions">
        <v-btn
          v-for="c in q.choices"
          :key="c"
          class="qs__choice"
          variant="tonal"
          min-height="44"
          height="auto"
          :disabled="savingId !== null"
          @click="emit('answer', q.id, c)"
        >
          {{ c }}
        </v-btn>
        <v-btn v-if="!q.blocking" variant="text" height="44" :disabled="savingId !== null" @click="emit('skip', q.id)">Skip</v-btn>
      </div>

      <form v-else class="qs__form" @submit.prevent="submitText(q)">
        <v-text-field
          v-model="drafts[q.id]"
          :label="q.answerType === 'number' ? 'Number' : 'Your answer'"
          :inputmode="inputMode(q)"
          enterkeyhint="send"
          autocomplete="off"
          hide-details
          density="comfortable"
          class="qs__field"
        />
        <v-btn
          type="submit"
          :color="(drafts[q.id] ?? '').trim() ? 'primary' : undefined"
          :variant="(drafts[q.id] ?? '').trim() ? 'flat' : 'tonal'"
          height="48"
          :loading="savingId === q.id"
          :disabled="!(drafts[q.id] ?? '').trim() || (savingId !== null && savingId !== q.id)"
        >
          Save
        </v-btn>
        <v-btn v-if="!q.blocking" variant="text" height="48" :disabled="savingId !== null" @click="emit('skip', q.id)">Skip</v-btn>
      </form>
    </article>

    <div v-if="refreshing" class="qs__refreshing" role="status">
      <v-progress-circular indeterminate size="14" width="2" />
      Updating the form answers with what you said
    </div>
  </div>
</template>

<style scoped lang="scss">
.qs {
  display: flex;
  flex-direction: column;
  gap: 10px;

  &__item {
    padding: 14px 16px;
    border-radius: 8px;
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    background: rgba(var(--v-theme-on-surface), 0.02);

    &--blocking {
      border-color: rgba(var(--v-theme-warning), 0.4);
      background: rgba(var(--v-theme-warning), 0.05);
    }
  }

  &__top {
    margin-bottom: 4px;
  }

  &__flag {
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: rgb(var(--v-theme-warning));

    &--soft {
      color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    }
  }

  &__question {
    font-size: 0.9375rem;
    font-weight: 600;
    line-height: 1.4;
    margin: 0 0 4px;
  }

  &__context {
    font-size: 0.8125rem;
    margin: 0 0 12px;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  // Long choices ("No, I opt out and do not consent to a recorded interview") wrap inside the
  // button instead of pushing it past the card edge on a phone.
  &__choice {
    max-width: 100%;
    white-space: normal;
    text-align: left;
    padding-top: 10px;
    padding-bottom: 10px;

    :deep(.v-btn__content) {
      white-space: normal;
      line-height: 1.3;
    }
  }

  &__form {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }

  &__field {
    flex: 1 1 200px;
    min-width: 0;
  }

  &__refreshing {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.8125rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }
}
</style>

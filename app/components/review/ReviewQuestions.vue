<script setup lang="ts">
import { useDisplay } from 'vuetify'
import type { QuestionView } from '#shared/types/pipeline'
import { plainKnowledgeRefs } from '#shared/utils/plain-text'
import type { ChatQuestion } from '~/components/questions/chat-store'

// Open questions answered in place. Yes or no and choices are one tap; numbers take one short
// field and written answers a growing box, each with Save. Answers go through
// PATCH /api/questions/:id via the parent. Ask about this opens the same chat as /questions
// in a dialog here, because the review card has no room for a side panel.
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

/** Same answer buttons as /questions: experience questions take Some experience too. */
function yesNoOptions(q: QuestionView) {
  return q.kind === 'knows' || q.kind === 'has_done' ? ['Yes', 'Some experience', 'No'] : ['Yes', 'No']
}

const YES_NO_ICONS: Record<string, string> = { 'Yes': 'mdi-check', 'Some experience': 'mdi-circle-half-full', 'No': 'mdi-close' }

// ── Ask Claude ──
const { xs } = useDisplay()
const root = ref<HTMLElement | null>(null)
const chatOpen = ref(false)
/** A copy of the question the chat is about. It stays after an answer removes it from the list. */
const chatQuestion = ref<ChatQuestion | null>(null)
/** The answer the chat sent, until the question leaves the open list. */
const chatAnswer = ref<string | null>(null)

function toChatQuestion(q: QuestionView): ChatQuestion {
  return {
    id: q.id,
    question: q.question,
    status: q.status,
    answer: q.answer,
    answerType: q.answerType,
    choices: q.choices,
    legacy: !q.kind && !q.answerType,
  }
}

function askAbout(q: QuestionView) {
  chatQuestion.value = toChatQuestion(q)
  chatAnswer.value = null
  chatOpen.value = true
}

function answerFromChat(value: string) {
  const q = chatQuestion.value
  if (!q) return
  chatAnswer.value = value
  emit('answer', q.id, value)
}

// The queue drops a question from the open list once its answer is saved.
watch(() => props.questions.map(q => q.id), (ids) => {
  const q = chatQuestion.value
  if (q && chatAnswer.value && !ids.includes(q.id)) {
    chatQuestion.value = { ...q, status: 'answered', answer: chatAnswer.value }
    chatAnswer.value = null
  }
})

function useDraft(text: string) {
  const q = chatQuestion.value
  if (!q) return
  drafts[q.id] = text
  chatOpen.value = false
  nextTick(() => {
    root.value?.querySelector(`[data-question-id="${q.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  })
}
</script>

<template>
  <div ref="root" class="qs">
    <article v-for="q in questions" :key="q.id" class="qs__item" :class="{ 'qs__item--blocking': q.blocking }" :data-question-id="q.id">
      <div class="qs__top">
        <span v-if="q.blocking" class="qs__flag">Blocks approve</span>
        <span v-else class="qs__flag qs__flag--soft">Optional</span>
        <v-btn
          variant="text"
          size="small"
          :color="chatOpen && chatQuestion?.id === q.id ? 'primary' : undefined"
          prepend-icon="mdi-chat-question-outline"
          class="qs__ask"
          @click="askAbout(q)"
        >
          Ask about this
        </v-btn>
      </div>
      <h4 class="qs__question">{{ q.question }}</h4>
      <p v-if="q.context" class="qs__context">{{ plainKnowledgeRefs(q.context) }}</p>

      <div v-if="q.answerType === 'yes_no'" class="qs__actions">
        <v-btn
          v-for="opt in yesNoOptions(q)"
          :key="opt"
          variant="tonal"
          :disabled="savingId !== null"
          min-width="96"
          height="44"
          :prepend-icon="YES_NO_ICONS[opt]"
          class="qs__yes-no"
          @click="emit('answer', q.id, opt)"
        >
          {{ opt }}
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

      <!-- Written answers can run to several paragraphs and bullet lines: the box grows with them,
           Enter adds a line, and only Save sends. 4,000 characters is the server's limit. -->
      <div v-else-if="q.answerType !== 'number'" class="qs__form qs__form--text">
        <v-textarea
          v-model="drafts[q.id]"
          label="Your answer"
          rows="3"
          auto-grow
          maxlength="4000"
          counter="4000"
          persistent-counter
          autocomplete="off"
          density="comfortable"
          class="qs__textarea"
        />
        <div class="qs__form-actions">
          <v-btn v-if="!q.blocking" variant="text" height="44" :disabled="savingId !== null" @click="emit('skip', q.id)">Skip</v-btn>
          <v-btn
            :color="(drafts[q.id] ?? '').trim() ? 'primary' : undefined"
            :variant="(drafts[q.id] ?? '').trim() ? 'flat' : 'tonal'"
            height="44"
            :loading="savingId === q.id"
            :disabled="!(drafts[q.id] ?? '').trim() || (savingId !== null && savingId !== q.id)"
            @click="submitText(q)"
          >
            Save
          </v-btn>
        </div>
      </div>

      <form v-else class="qs__form" @submit.prevent="submitText(q)">
        <v-text-field
          v-model="drafts[q.id]"
          label="Number"
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

    <v-dialog v-model="chatOpen" :fullscreen="xs" max-width="560" class="qs-chat" aria-label="Ask Claude">
      <QuestionsChatPanel
        variant="dialog"
        class="qs-chat__panel"
        :question="chatQuestion"
        :saving="chatQuestion && savingId === chatQuestion.id ? chatAnswer : null"
        :box-text="chatQuestion ? drafts[chatQuestion.id] ?? '' : ''"
        @answer="answerFromChat"
        @use-draft="useDraft"
        @detach="chatQuestion = null"
        @close="chatOpen = false"
      />
    </v-dialog>
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
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 4px;
  }

  // A text button in the flag row; 44px tall so it is easy to tap on a phone.
  &__ask {
    min-height: 44px;
    margin-right: -8px;
    text-transform: none;
    letter-spacing: normal;
  }

  &__yes-no {
    text-transform: none;
    letter-spacing: normal;
  }

  &__flag {
    font-size: 0.75rem;
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

  &__form--text {
    flex-direction: column;
    align-items: stretch;
  }

  &__textarea {
    width: 100%;
  }

  &__form-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
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

<style lang="scss">
// The dialog content is teleported out of the card, so these rules cannot be scoped.
.v-dialog.qs-chat .question-chat.qs-chat__panel {
  height: min(720px, calc(100dvh - 48px));
}

.v-dialog.qs-chat.v-dialog--fullscreen .question-chat.qs-chat__panel {
  height: 100%;
  height: 100dvh;
}
</style>

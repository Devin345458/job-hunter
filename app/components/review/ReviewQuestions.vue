<script setup lang="ts">
import { useDisplay } from 'vuetify'
import type { QuestionView } from '#shared/types/pipeline'
import { plainKnowledgeRefs, plainQuestionContext } from '#shared/utils/plain-text'
import { EXAMPLE_LEVELS, EXAMPLE_MAX_CHARS, takesExample, type ChatQuestion } from '~/components/questions/chat-store'

// Open questions answered in place. Yes or no and choices are one tap; numbers take one short
// field and written answers a growing box, each with Save. Answers go through
// PATCH /api/questions/:id via the parent. Ask about this opens the same chat as /questions
// in a dialog here, because the review card has no room for a side panel.
// On a skill or experience question, Yes and Some experience open "Where did you do it?" in the
// same item; nothing saves until Save or Save without an example. The parents forward the answer
// string untouched, so the example rides on the lines after the answer ("Yes\n<example>") and
// the server splits it (answerQuestion in server/utils/questions.ts).
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

// ── The example ("Where did you do it?") ──
const isExampleLevel = (opt: string | null | undefined) => !!opt && (EXAMPLE_LEVELS as readonly string[]).includes(opt)
/** Yes or Some experience picked per question, waiting on the example box. */
const levels = reactive<Record<number, string | null>>({})
/** Open example boxes and their text, per question. */
const exampleOpen = reactive<Record<number, boolean>>({})
const examples = reactive<Record<number, string>>({})
/** Which example button was pressed per question, so only it spins. */
const exampleAction = reactive<Record<number, 'save' | 'without' | null>>({})

function tapYesNo(q: QuestionView, opt: string) {
  if (props.savingId !== null) return
  if (!takesExample(q) || !isExampleLevel(opt)) {
    levels[q.id] = null
    exampleOpen[q.id] = false
    emit('answer', q.id, opt)
    return
  }
  levels[q.id] = opt
  exampleOpen[q.id] = true
}

function exampleText(q: QuestionView) {
  return (examples[q.id] ?? '').trim()
}

function canSaveExample(q: QuestionView) {
  const text = exampleText(q)
  return !!levels[q.id] && !!text && text.length <= EXAMPLE_MAX_CHARS
}

function saveExample(q: QuestionView) {
  if (!canSaveExample(q) || props.savingId !== null) return
  exampleAction[q.id] = 'save'
  emit('answer', q.id, `${levels[q.id]}\n${exampleText(q)}`)
}

function saveWithoutExample(q: QuestionView) {
  const level = levels[q.id]
  if (!level || props.savingId !== null) return
  exampleAction[q.id] = 'without'
  emit('answer', q.id, level)
}

// The spinner choice resets once the save ends; a failed save keeps the box and its text.
watch(() => props.savingId, (now, before) => {
  if (now === null && before !== null) exampleAction[before] = null
})

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
    kind: q.kind,
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
  // Yes or Some experience on a skill or experience question opens the example box on the item.
  const item = props.questions.find(x => x.id === q.id)
  if (item && takesExample(item) && isExampleLevel(value)) {
    tapYesNo(item, value)
    chatOpen.value = false
    scrollToItem(q.id)
    return
  }
  chatAnswer.value = value
  emit('answer', q.id, value)
}

function scrollToItem(id: number) {
  nextTick(() => {
    root.value?.querySelector(`[data-question-id="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  })
}

// The queue drops a question from the open list once its answer is saved.
watch(() => props.questions.map(q => q.id), (ids) => {
  const q = chatQuestion.value
  if (q && chatAnswer.value && !ids.includes(q.id)) {
    chatQuestion.value = { ...q, status: 'answered', answer: chatAnswer.value }
    chatAnswer.value = null
  }
})

function useDraft(text: string, level: string | null = null) {
  const q = chatQuestion.value
  if (!q) return
  if (takesExample(q)) {
    if (level && isExampleLevel(level)) levels[q.id] = level
    examples[q.id] = text
    exampleOpen[q.id] = true
  }
  else {
    drafts[q.id] = text
  }
  chatOpen.value = false
  scrollToItem(q.id)
}

/** What the chat's "Use this draft" would replace on the item it is about. */
const chatBoxText = computed(() => {
  const q = chatQuestion.value
  if (!q) return ''
  return takesExample(q) ? examples[q.id] ?? '' : drafts[q.id] ?? ''
})
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
      <p v-if="q.context" class="qs__context">{{ plainKnowledgeRefs(plainQuestionContext(q.context)) }}</p>
      <QuestionsMemoryLeads :question-id="q.id" :takes-example="takesExample(q)" @ask="askAbout(q)" />

      <template v-if="q.answerType === 'yes_no'">
        <div class="qs__actions">
          <v-btn
            v-for="opt in yesNoOptions(q)"
            :key="opt"
            :variant="levels[q.id] === opt ? 'outlined' : 'tonal'"
            :color="levels[q.id] === opt ? 'primary' : undefined"
            :aria-pressed="levels[q.id] === opt"
            :disabled="savingId !== null"
            min-width="96"
            height="44"
            :prepend-icon="YES_NO_ICONS[opt]"
            class="qs__yes-no"
            @click="tapYesNo(q, opt)"
          >
            {{ opt }}
          </v-btn>
          <v-btn v-if="!q.blocking" variant="text" height="44" :disabled="savingId !== null" @click="emit('skip', q.id)">Skip</v-btn>
        </div>

        <!-- After Yes or Some experience: where he did it, in his own words -->
        <div v-if="exampleOpen[q.id]" class="qs__example" role="group" :aria-labelledby="`qs-example-${q.id}-label`">
          <label :id="`qs-example-${q.id}-label`" :for="`qs-example-${q.id}`" class="qs__example-label">Where did you do it?</label>
          <p class="qs__example-hint">The job or project, what you did, and the result if there was one. It is saved exactly as you write it.</p>
          <p v-if="!levels[q.id]" class="qs__example-pick">Tap Yes or Some experience above, then save.</p>
          <v-textarea
            :id="`qs-example-${q.id}`"
            v-model="examples[q.id]"
            rows="3"
            auto-grow
            :maxlength="EXAMPLE_MAX_CHARS"
            :counter="EXAMPLE_MAX_CHARS"
            persistent-counter
            autocomplete="off"
            autofocus
            density="comfortable"
            :disabled="savingId !== null"
            class="qs__textarea"
          />
          <div class="qs__example-actions">
            <v-btn
              :color="canSaveExample(q) ? 'primary' : undefined"
              :variant="canSaveExample(q) ? 'flat' : 'tonal'"
              height="44"
              :loading="savingId === q.id && exampleAction[q.id] === 'save'"
              :disabled="!canSaveExample(q) || (savingId !== null && savingId !== q.id)"
              @click="saveExample(q)"
            >
              Save
            </v-btn>
            <v-btn
              variant="text"
              height="44"
              :loading="savingId === q.id && exampleAction[q.id] === 'without'"
              :disabled="!levels[q.id] || (savingId !== null && savingId !== q.id)"
              @click="saveWithoutExample(q)"
            >
              Save without an example
            </v-btn>
          </div>
        </div>
      </template>

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
        :box-text="chatBoxText"
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

  &__example {
    margin-top: 12px;
    padding: 12px 14px 10px;
    border-radius: 8px;
    border: 1px solid rgba(var(--v-theme-primary), 0.35);
    background: rgba(var(--v-theme-primary), 0.05);
  }

  &__example-label {
    display: block;
    font-size: 0.9375rem;
    font-weight: 600;
    line-height: 1.4;
  }

  &__example-hint {
    font-size: 0.8125rem;
    line-height: 1.45;
    margin: 2px 0 10px;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__example-pick {
    font-size: 0.8125rem;
    margin: -2px 0 10px;
    color: rgb(var(--v-theme-warning));
  }

  &__example-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;

    :deep(.v-btn) {
      text-transform: none;
      letter-spacing: normal;
    }
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

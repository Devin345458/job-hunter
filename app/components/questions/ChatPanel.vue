<script setup lang="ts">
import { asksForRecordsDraft, chatThreadKey, draftsFromRecords, EXAMPLE_LEVELS, RECORDS_DRAFT_LABEL, takesExample, useDraftStepLine, useQuestionChat, type ChatMessage, type ChatQuestion, type DraftMeta } from './chat-store'
import type { RecordsDraft } from '#shared/types/question-chat'

// Ask Claude about a question before answering it. Shown as a sticky column beside the question
// list on wide screens and inside a dialog on narrower ones; both read the same conversations.
// A suggested answer is only a button: nothing is saved until Devin taps it. A draft only goes
// into the card's answer box for him to edit and save. On a skill or experience question the draft
// is an example for the "Where did you do it?" box, written only from what he types here, and a
// suggested Yes or Some experience opens that box instead of saving.
// "Draft from my records" drafts from his knowledge base, his GitHub, his past Claude sessions, and
// what he typed here, and lists the source of every sentence under the draft.

const props = defineProps<{
  /** The question the chat is about. Null for a general question. */
  question: ChatQuestion | null
  /** The answer value being saved for that question right now. */
  saving?: string | null
  /** What is in that question's answer box (or example box) now, so "Use this draft" can ask before replacing it. */
  boxText?: string
  variant: 'panel' | 'dialog'
}>()

const emit = defineEmits<{
  answer: [value: string]
  useDraft: [text: string, level: string | null, meta?: DraftMeta]
  detach: []
  close: []
}>()

const chat = useQuestionChat()
const text = ref('')
const log = ref<HTMLElement | null>(null)
const input = ref<{ focus: () => void } | null>(null)

const key = computed(() => chatThreadKey(props.question?.id))
const messages = computed(() => chat.threads.value[key.value] ?? [])
const busy = computed(() => !!chat.sending.value[key.value])
const draftingRecords = computed(() => !!chat.drafting.value[key.value])
/** "Searching your GitHub (12 seconds)" while a draft from records runs. */
const draftStepLine = useDraftStepLine(key)
/** This question can take a draft from his records. */
const recordsDraftable = computed(() => draftsFromRecords(props.question))
/** The first reply in this conversation that had memory excerpts in its prompt; it alone carries the note. */
const firstMemoryReply = computed(() => messages.value.find(m => m.role === 'assistant' && m.memory === 'used')?.id ?? null)
const job = computed(() => props.question?.job ?? props.question?.waitingApplications?.[0] ?? null)
const writesAnswer = computed(() => {
  const q = props.question
  if (!q) return false
  if (q.legacy) return true
  if (q.answerType === 'yes_no' || q.answerType === 'number') return false
  return !(q.answerType === 'choice' && q.choices?.length)
})

/** The question takes an example ("Where did you do it?") with a Yes or Some experience answer. */
const exampleQuestion = computed(() => takesExample(props.question))
/** Answered No: there is no example to write. */
const answeredNo = computed(() => props.question?.status === 'answered' && (props.question.answer ?? '').trim().toLowerCase() === 'no')

const starters = computed(() => {
  if (!props.question) return []
  if (writesAnswer.value) return recordsDraftable.value ? ['What does this mean?'] : ['What does this mean?', 'Help me answer this']
  if (exampleQuestion.value && !answeredNo.value && props.question.status !== 'skipped') {
    return props.question.status === 'answered' ? ['What does this mean?'] : ['What does this mean?', 'What would count as a yes?']
  }
  return ['What does this mean?', 'What would count as a yes?']
})

/** "Draft from my records", from the button or from a typed ask ("draft it from my records"). */
function draftFromRecords(typed?: string) {
  const q = props.question
  if (!q || busy.value) return
  chat.draftFromRecords(q.id, typed)
}

/** Where a draft goes on the card. */
const boxName = computed(() => exampleQuestion.value ? 'example box' : 'answer box')

/** A suggested Yes or Some experience on a skill or experience question opens the example box rather than saving. */
function opensExample(value: string) {
  return exampleQuestion.value && value !== 'No'
}

const placeholder = computed(() => props.question ? 'Ask about this question' : 'Ask about any term')

function submit(value = text.value) {
  const v = value.trim()
  if (!v || busy.value) return
  text.value = ''
  if (props.question && recordsDraftable.value && asksForRecordsDraft(v)) draftFromRecords(v)
  else chat.send(props.question?.id ?? null, v)
}

function onEnter(e: KeyboardEvent) {
  if (e.isComposing) return
  e.preventDefault()
  submit()
}

/** The suggestion is already the saved answer. */
function isSaved(value: string) {
  return props.question?.status === 'answered' && (props.question.answer ?? '').trim().toLowerCase() === value.toLowerCase()
}

function canSuggest(value: string) {
  return props.question?.status === 'pending' || isSaved(value)
}

const canUseDraft = computed(() => !!props.question && props.question.status !== 'skipped' && !(exampleQuestion.value && answeredNo.value))

/**
 * One action at a time: while the newest message is a draft he has not used, its "Use this draft"
 * is the action, and the "Draft from my records" bar waits. It comes back after he sends a new
 * message or uses the draft, as "Draft again from my records" once a draft from his records exists.
 */
const draftWaiting = computed(() => {
  const last = messages.value[messages.value.length - 1]
  return !!last && last.role === 'assistant' && !!last.draft && canUseDraft.value && !last.used
})
const recordsBarLabel = computed(() => messages.value.some(m => m.role === 'assistant' && m.records) ? 'Draft again from my records' : 'Draft from my records')

/** The draft message waiting on "Replace what you typed?". */
const confirmingDraft = ref<string | null>(null)

/**
 * On a pending skill or experience question a draft example means a yes: "Use this draft" picks the
 * level Claude suggested (Some experience when it said so, else Yes) and fills the example box in one tap.
 */
function draftLevel(m: { suggestedAnswer?: string | null; records?: RecordsDraft | null }): string | null {
  if (!exampleQuestion.value || props.question?.status !== 'pending') return null
  // A draft from his records carries its own level; none (nothing found) picks none.
  if (m.records) return m.records.level
  const s = m.suggestedAnswer ?? ''
  return (EXAMPLE_LEVELS as readonly string[]).includes(s) ? s : 'Yes'
}

/** A suggested Yes or Some experience is folded into "Use this draft" when the same message has a draft. */
function foldedIntoDraft(m: { draft?: string | null; suggestedAnswer?: string | null }): boolean {
  return !!m.draft && canUseDraft.value && !!m.suggestedAnswer && opensExample(m.suggestedAnswer)
}

function useDraft(id: string, draft: string, level: string | null = null) {
  const typed = (props.boxText ?? '').trim()
  if (typed && typed !== draft.trim() && confirmingDraft.value !== id) {
    confirmingDraft.value = id
    return
  }
  confirmingDraft.value = null
  const m = messages.value.find(x => x.id === id)
  emit('useDraft', draft, level, m?.records ? { records: m.records, memoryNote: memoryNoteBefore(m) } : undefined)
  chat.markDraftUsed(props.question?.id ?? null, id)
}

/** The memory line the app put just before a records draft, if any. */
function memoryNoteBefore(m: ChatMessage): string | null {
  const i = messages.value.findIndex(x => x.id === m.id)
  const prev = i > 0 ? messages.value[i - 1] : null
  return prev?.role === 'notice' && /memory/i.test(prev.content) ? prev.content : null
}

watch(key, () => {
  confirmingDraft.value = null
})

function scrollToEnd() {
  nextTick(() => {
    const el = log.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

watch(() => [messages.value.length, busy.value, key.value], scrollToEnd)

onMounted(() => {
  chat.restore()
  scrollToEnd()
})

defineExpose({ focus: () => input.value?.focus() })
</script>

<template>
  <section class="question-chat" :class="`question-chat--${variant}`" aria-label="Ask Claude">
    <header class="question-chat__head">
      <v-icon icon="mdi-chat-question-outline" size="20" class="question-chat__head-icon" />
      <h2 class="question-chat__title">Ask Claude</h2>
      <v-spacer />
      <v-btn
        variant="text"
        size="small"
        class="question-chat__head-btn"
        prepend-icon="mdi-broom"
        :disabled="!messages.length || busy"
        @click="chat.clear(question?.id ?? null)"
      >
        Clear
      </v-btn>
      <v-btn
        v-if="variant === 'dialog'"
        variant="text"
        size="small"
        class="question-chat__head-btn"
        icon="mdi-close"
        aria-label="Close the chat"
        @click="emit('close')"
      />
    </header>

    <div class="question-chat__about">
      <template v-if="question">
        <div class="question-chat__about-label text-caption text-medium-emphasis">About this question</div>
        <p class="question-chat__about-question text-body-2 font-weight-medium">{{ question.question }}</p>
        <div v-if="job" class="text-caption text-medium-emphasis question-chat__about-job">
          {{ job.title }} at {{ job.company }}
        </div>
        <QuestionsMemoryLeads v-if="question.status === 'pending'" variant="chat" :question-id="question.id" :takes-example="exampleQuestion" />
        <v-btn
          variant="text"
          size="small"
          class="question-chat__general"
          prepend-icon="mdi-swap-horizontal"
          @click="emit('detach')"
        >
          Ask a general question instead
        </v-btn>
      </template>
      <template v-else>
        <div class="question-chat__about-label text-caption text-medium-emphasis">General question</div>
        <p class="text-body-2 text-medium-emphasis question-chat__hint">
          Ask about a term or a requirement you do not recognize, for example "what does HUD 202D mean?" To ask about one question, use Ask about this on its card.
        </p>
      </template>
    </div>

    <div ref="log" class="question-chat__log" role="log" aria-live="polite" aria-label="Conversation">
      <div v-if="!messages.length && !busy" class="question-chat__empty">
        <p class="text-body-2 text-medium-emphasis">
          {{ question
            ? recordsDraftable
              ? 'Claude explains what the employer is asking and what would count. Draft from my records writes a first draft from your knowledge base, your GitHub, and your past Claude sessions, with the source of every sentence. Nothing is saved until you press Save.'
              : 'Claude explains what the employer is asking and what would count, using only your knowledge base as facts about you. It never answers for you.'
            : 'Claude explains in plain words. It uses your knowledge base as the only facts about you.' }}
        </p>
        <div v-if="starters.length || recordsDraftable" class="question-chat__starters">
          <v-btn
            v-if="recordsDraftable"
            color="primary"
            variant="flat"
            class="question-chat__starter"
            prepend-icon="mdi-file-document-edit-outline"
            @click="draftFromRecords()"
          >
            Draft from my records
          </v-btn>
          <v-btn
            v-for="s in starters"
            :key="s"
            variant="tonal"
            class="question-chat__starter"
            @click="submit(s)"
          >
            {{ s }}
          </v-btn>
        </div>
      </div>

      <div
        v-for="m in messages"
        :key="m.id"
        class="question-chat__msg"
        :class="`question-chat__msg--${m.role}`"
      >
        <template v-if="m.role === 'notice'">
          <v-icon icon="mdi-alert-circle-outline" size="18" class="question-chat__notice-icon" />
          <span class="question-chat__text">{{ m.content }}</span>
        </template>
        <template v-else>
          <div class="question-chat__text">{{ m.content }}</div>
          <div v-if="m.id === firstMemoryReply" class="question-chat__memory text-caption text-medium-emphasis">
            <v-icon icon="mdi-history" size="14" />
            Excerpts from your past Claude sessions were in this reply. They are leads, not proof of work you did.
          </div>
          <QuestionsChatGithub v-if="m.role === 'assistant' && m.github" :search="m.github" />

          <div v-if="m.role === 'assistant' && m.draft" class="question-chat__draft">
            <div class="question-chat__draft-label text-caption text-medium-emphasis">{{ m.records ? RECORDS_DRAFT_LABEL : exampleQuestion ? 'Draft example' : 'Draft answer' }}</div>
            <QuestionsRecordsSources v-if="m.records" :draft="m.records" />
            <div v-else class="question-chat__draft-text">{{ m.draft }}</div>
            <div v-if="canUseDraft && confirmingDraft === m.id" class="question-chat__confirm" role="alert">
              <span class="text-body-2">Replace what you already typed in the {{ boxName }}?</span>
              <div class="question-chat__confirm-actions">
                <v-btn color="primary" variant="flat" class="question-chat__action" @click="useDraft(m.id, m.draft!, draftLevel(m))">Replace</v-btn>
                <v-btn variant="text" class="question-chat__action" @click="confirmingDraft = null">Keep mine</v-btn>
              </div>
            </div>
            <div v-else-if="canUseDraft" class="question-chat__draft-actions">
              <v-btn color="primary" variant="tonal" class="question-chat__action" prepend-icon="mdi-text-box-edit-outline" @click="useDraft(m.id, m.draft!, draftLevel(m))">
                Use this draft
              </v-btn>
              <span class="text-caption text-medium-emphasis">
                {{ draftLevel(m) ? `Picks ${draftLevel(m)} and puts the draft in the example box.` : `Puts it in the ${boxName} on the card.` }}
                Nothing is saved until you press Save.
              </span>
            </div>
          </div>

          <div v-if="m.role === 'assistant' && m.suggestedAnswer && canSuggest(m.suggestedAnswer) && !foldedIntoDraft(m)" class="question-chat__suggest">
            <div v-if="isSaved(m.suggestedAnswer)" class="question-chat__saved text-body-2">
              <v-icon icon="mdi-check-circle-outline" size="18" />
              Answered: {{ m.suggestedAnswer }}
            </div>
            <template v-else>
              <v-btn
                color="primary"
                variant="tonal"
                class="question-chat__action"
                prepend-icon="mdi-reply-outline"
                :loading="saving === m.suggestedAnswer"
                :disabled="!!saving && saving !== m.suggestedAnswer"
                @click="emit('answer', m.suggestedAnswer!)"
              >
                Answer: {{ m.suggestedAnswer }}
              </v-btn>
              <span class="text-caption text-medium-emphasis">{{ opensExample(m.suggestedAnswer) ? 'Opens the example box on the card. Nothing is saved until you press Save.' : 'Saves this answer to your knowledge base.' }}</span>
            </template>
          </div>
        </template>
      </div>

      <div v-if="busy" class="question-chat__msg question-chat__msg--assistant question-chat__thinking">
        <v-progress-circular indeterminate size="16" width="2" color="primary" />
        <span class="text-body-2 text-medium-emphasis" role="status">{{ draftingRecords ? draftStepLine : 'Claude is thinking' }}</span>
      </div>
    </div>

    <div v-if="recordsDraftable && messages.length && !draftWaiting" class="question-chat__records">
      <v-btn
        variant="tonal"
        color="primary"
        size="small"
        class="question-chat__records-btn"
        prepend-icon="mdi-file-document-edit-outline"
        :disabled="busy"
        @click="draftFromRecords()"
      >
        {{ recordsBarLabel }}
      </v-btn>
      <span class="text-caption text-medium-emphasis">Uses what you typed here too.</span>
    </div>

    <form class="question-chat__compose" @submit.prevent="submit()">
      <v-textarea
        ref="input"
        v-model="text"
        :placeholder="placeholder"
        rows="1"
        auto-grow
        max-rows="5"
        maxlength="4000"
        hide-details
        enterkeyhint="send"
        aria-label="Message to Claude"
        class="question-chat__input"
        @keydown.enter.exact="onEnter"
      />
      <v-btn
        type="submit"
        color="primary"
        :variant="text.trim() ? 'flat' : 'tonal'"
        class="question-chat__send"
        :disabled="!text.trim() || busy"
        :loading="busy"
        aria-label="Send"
        icon="mdi-send"
      />
    </form>
  </section>
</template>

<style scoped lang="scss">
.question-chat {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  background: rgb(var(--v-theme-surface));
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 12px;
  overflow: hidden;

  &--dialog {
    border-radius: 0;
    border: 0;

    @media (min-width: 600px) {
      border-radius: 12px;
      border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    }
  }

  &__head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 52px;
    padding: 4px 8px 4px 16px;
    border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  }

  &__head-icon {
    color: rgb(var(--v-theme-primary));
  }

  &__title {
    font-size: 0.9375rem;
    font-weight: 600;
    letter-spacing: -0.005em;
  }

  &__head-btn {
    min-height: 44px;
    min-width: 44px;
  }

  &__about {
    padding: 12px 16px;
    background: rgb(var(--v-theme-background));
    border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  }

  &__about-label {
    margin-bottom: 2px;
  }

  &__about-question {
    line-height: 1.45;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  &__about-job {
    margin-top: 2px;
    overflow-wrap: anywhere;
  }

  &__general {
    margin: 4px 0 -4px -8px;
    min-height: 44px;
  }

  &__hint {
    line-height: 1.5;
  }

  &__log {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  &__empty {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  &__starters {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  &__starter {
    min-height: 44px;
    text-transform: none;
    letter-spacing: normal;
  }

  &__msg {
    max-width: 100%;
    font-size: 0.875rem;
    line-height: 1.55;

    &--user {
      align-self: flex-end;
      max-width: 88%;
      padding: 8px 12px;
      border-radius: 8px;
      background: rgba(var(--v-theme-primary), 0.14);
    }

    &--assistant {
      align-self: stretch;
    }

    &--notice {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 10px 12px;
      border-radius: 8px;
      background: rgba(var(--v-theme-warning), 0.1);
      border: 1px solid rgba(var(--v-theme-warning), 0.3);
    }
  }

  &__notice-icon {
    color: rgb(var(--v-theme-warning));
    margin-top: 2px;
    flex: 0 0 auto;
  }

  &__text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  &__memory {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-top: 6px;
  }

  &__draft {
    margin-top: 10px;
    padding: 12px;
    border-radius: 8px;
    background: rgb(var(--v-theme-sunken));
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  }

  &__draft-label {
    margin-bottom: 4px;
  }

  &__draft-text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  &__draft-actions,
  &__suggest {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 12px;
    margin-top: 10px;
  }

  &__confirm {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 10px;
    padding: 10px 12px;
    border-radius: 8px;
    background: rgba(var(--v-theme-warning), 0.1);
    border: 1px solid rgba(var(--v-theme-warning), 0.3);
  }

  &__confirm-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  &__action {
    min-height: 44px;
    text-transform: none;
    letter-spacing: normal;
    max-width: 100%;
  }

  &__saved {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 32px;
    color: rgb(var(--v-theme-success));
    font-weight: 500;
  }

  &__thinking {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  &__records {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 10px;
    padding: 8px 12px 0;
    border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  }

  &__records-btn {
    min-height: 36px;
    text-transform: none;
    letter-spacing: normal;
  }

  &__records + &__compose {
    border-top: 0;
  }

  &__compose {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    padding: 12px;
    border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  }

  &__input {
    flex: 1 1 auto;
    min-width: 0;
  }

  &__send {
    flex: 0 0 auto;
    width: 48px;
    height: 48px;
  }
}
</style>

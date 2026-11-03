<script setup lang="ts">
import type { QuestionListItem } from '#shared/types/learning'
import { plainQuestionContext } from '#shared/utils/plain-text'
import type { RecordsDraft } from '#shared/types/question-chat'
import { draftsFromRecords, EXAMPLE_LEVELS, EXAMPLE_MAX_CHARS, RECORDS_DRAFT_LABEL, chatThreadKey, useQuestionChat } from '~/components/questions/chat-store'

// One question on the /questions page. Yes or no questions answer in one tap; choices are one
// tap; numbers and short facts take a field; open-ended questions from the original tailoring
// flow open a text box. The parent sends the answer and removes or moves the card.
// A skill or experience question asks for an example after Yes or Some experience: "Where did
// you do it?" opens under the buttons, and nothing is saved until Save or Save without an example.
// "Draft from my records" fills the example box (or the answer box) with a draft from Devin's
// knowledge base, GitHub, and past Claude sessions, picks the level, and lists the source of every
// sentence under the box. It is still only a draft: nothing is saved until Save.

const props = defineProps<{
  question: QuestionListItem
  /** Which list the card sits in. */
  mode: 'pending' | 'answered' | 'skipped'
  /** The answer value being saved right now ('example' while only the example saves), so only that button spins. */
  saving?: string | null
  /** This question is the one loaded in the chat panel. */
  asking?: boolean
  /** A draft from the chat's "Use this draft". Each new nonce puts its text in the answer box (or the example box); nothing is saved until Save. */
  prefill?: { text: string; nonce: number; level?: string | null; records?: RecordsDraft | null; memoryNote?: string | null } | null
  /** The chat's suggested Yes or Some experience on a skill or experience question. Each new nonce picks it and opens the example box. */
  pick?: { level: string; nonce: number } | null
}>()

const emit = defineEmits<{
  /** example: text sets it, null saves without one (or clears it), absent keeps the saved one. */
  answer: [answer: string, example?: string | null]
  /** Adds or changes the example on an answered Yes or Some experience question. */
  example: [text: string]
  skip: []
  reopen: []
  ask: []
  /** What is in the answer box (or the example box) while it is open, so the chat can ask before a draft replaces it. */
  boxText: [text: string]
}>()

const COMP_FLOOR_SUBJECT = 'compensation floor'

const editing = ref(false)
const draft = ref('')

// ── The example ("Where did you do it?") ──
/** Yes or Some experience picked and waiting on the example box. */
const level = ref<string | null>(null)
const exampleOpen = ref(false)
const exampleText = ref('')
/** Answered card: adding or editing only the example, the answer stays. */
const exampleOnly = ref(false)
/** Which example button was pressed, so only it spins. */
const exampleAction = ref<'save' | 'without' | null>(null)
const exampleBoxId = computed(() => `question-${props.question.id}-example`)

const isComp = computed(() => props.question.subject === COMP_FLOOR_SUBJECT)
const isExperience = computed(() => props.question.kind === 'knows' || props.question.kind === 'has_done')
const takesExample = computed(() => props.question.takesExample && !props.question.legacy)
const isExampleLevel = (opt: string | null | undefined) => !!opt && (EXAMPLE_LEVELS as readonly string[]).includes(opt)
/** Answered Yes or Some experience on a question that takes an example. */
const answeredWithLevel = computed(() => props.mode === 'answered' && takesExample.value && isExampleLevel(props.question.answer))
const missingExample = computed(() => answeredWithLevel.value && !props.question.example)
const yesNoOptions = computed(() => isExperience.value ? ['Yes', 'Some experience', 'No'] : ['Yes', 'No'])
const inputType = computed<'yes_no' | 'choice' | 'number' | 'text' | 'long'>(() => {
  if (props.question.legacy) return 'long'
  if (props.question.answerType === 'yes_no') return 'yes_no'
  if (props.question.answerType === 'choice' && props.question.choices?.length) return 'choice'
  if (props.question.answerType === 'number') return 'number'
  return 'text'
})
const showInput = computed(() => props.mode === 'pending' || editing.value)
const busy = computed(() => !!props.saving)

const kindLabel = computed(() => {
  switch (props.question.kind) {
    case 'knows': return 'Skill'
    case 'has_done': return 'Experience'
    case 'preference': return 'Preference'
    case 'fact': return 'Fact'
    case 'form_field': return 'Application form'
    case 'other': return 'Other'
  }
  if (props.question.category === 'behavioral') return 'Interview prep'
  if (props.question.category === 'technical') return 'Technical'
  if (props.question.category === 'preference') return 'Preference'
  return 'Question'
})

const waiting = computed(() => props.question.waitingApplicationIds.length)
/** Every application waiting on this question, with its company, when the server sent them. */
const waiters = computed(() => props.question.waitingApplications ?? [])
/** A shared question's stored context names whichever employer asked first, so it is hidden then. */
const shared = computed(() => waiters.value.length > 1)

const savedAs = computed(() => {
  const key = props.question.knowledgeKey
  if (!key) return null
  const i = key.indexOf(':')
  return i > 0 ? `${key.slice(0, i)}: ${key.slice(i + 1)}` : key
})

const shownAnswer = computed(() => {
  const a = props.question.answer
  if (a && isComp.value && /^\d+$/.test(a)) return `$${Number(a).toLocaleString('en-US')} a year`
  return a
})

const numberValid = computed(() => /^\$?\s*\d[\d,]*(\.\d+)?\s*k?$/i.test(draft.value.trim()))

/** The saved answer, marked while changing it. A pending question has no answer, so nothing is marked. */
function isCurrent(opt: string) {
  return props.mode === 'answered' && editing.value && (props.question.answer ?? '').trim().toLowerCase() === opt.toLowerCase()
}

/** The button shown as chosen: the picked Yes or Some experience, else the saved answer while changing it. */
function isChosen(opt: string) {
  return level.value ? level.value === opt : isCurrent(opt)
}

// ── Draft from my records ──
const chat = useQuestionChat()
/** The draft from records now in the box, with the source of each sentence. Cleared when the box closes. */
const recordsDraft = ref<RecordsDraft | null>(null)
const recordsNote = ref<string | null>(null)
/** The server's sentence when there was no draft, or why it could not draft. */
const recordsMessage = ref<string | null>(null)
/** A draft waiting on "Replace what you typed?". */
const pendingRecords = ref<{ draft: RecordsDraft; note: string | null } | null>(null)
const recordsBusy = computed(() => !!chat.drafting.value[chatThreadKey(props.question.id)])
const canDraftRecords = computed(() => {
  if (!draftsFromRecords(props.question)) return false
  if (props.mode === 'pending') return true
  return props.mode === 'answered' && (takesExample.value ? answeredWithLevel.value : true)
})

/** What the box the draft would fill holds now. */
function boxNow(): string {
  return (takesExample.value ? exampleText.value : draft.value).trim()
}

function fillFromRecords(d: RecordsDraft, note: string | null) {
  pendingRecords.value = null
  if (takesExample.value) {
    if (props.mode === 'answered' && !editing.value) {
      if (!answeredWithLevel.value) return
      exampleOnly.value = true
    }
    if (props.mode === 'pending' && d.level && isExampleLevel(d.level)) level.value = d.level
    exampleText.value = d.text
    exampleOpen.value = true
  }
  else {
    if (props.mode === 'answered' || inputType.value === 'long') editing.value = true
    draft.value = d.text
  }
  recordsDraft.value = d
  recordsNote.value = note
}

async function draftFromRecords() {
  if (busy.value || recordsBusy.value) return
  recordsMessage.value = null
  pendingRecords.value = null
  const res = await chat.draftFromRecords(props.question.id)
  if (!res) return
  if (!res.ok) {
    recordsMessage.value = res.message
    return
  }
  if (!res.draft) {
    recordsMessage.value = [res.memoryNote, res.reply].filter(Boolean).join(' ')
    return
  }
  const typed = boxNow()
  if (typed && typed !== res.draft.text.trim() && (takesExample.value ? exampleOpen.value : showInput.value)) {
    pendingRecords.value = { draft: res.draft, note: res.memoryNote }
    return
  }
  fillFromRecords(res.draft, res.memoryNote)
}

function clearRecords() {
  recordsDraft.value = null
  recordsNote.value = null
  pendingRecords.value = null
}

function closeExample() {
  level.value = null
  exampleOpen.value = false
  exampleOnly.value = false
  exampleText.value = ''
  exampleAction.value = null
  clearRecords()
}

function startEdit() {
  draft.value = props.question.legacy || props.question.answerType === 'text' ? (props.question.answer ?? '') : ''
  closeExample()
  editing.value = true
}

function cancelEdit() {
  editing.value = false
  draft.value = ''
  closeExample()
}

// The draft from records goes with the box: once Devin empties it, the sources no longer describe it.
watch(() => (takesExample.value ? exampleText.value : draft.value), (text) => {
  if (recordsDraft.value && !text.trim()) clearRecords()
})

function send(value: string) {
  const v = value.trim()
  if (!v || busy.value) return
  emit('answer', v)
}

/** A Yes or No tap. Yes and Some experience on a skill or experience question open the example box; nothing saves yet. */
function tap(opt: string) {
  if (busy.value) return
  if (!takesExample.value || !isExampleLevel(opt)) {
    closeExample()
    send(opt)
    return
  }
  // Changing a saved answer starts from the saved example, so switching Yes to Some experience keeps it.
  if (!exampleOpen.value && !exampleText.value && props.mode === 'answered') exampleText.value = props.question.example ?? ''
  level.value = opt
  exampleOpen.value = true
}

function startExample() {
  exampleText.value = props.question.example ?? ''
  exampleOnly.value = true
  exampleOpen.value = true
}

const exampleChanged = computed(() => exampleText.value.trim() !== (props.question.example ?? '').trim())
const canSaveExample = computed(() => !!exampleText.value.trim()
  && (exampleOnly.value ? exampleChanged.value : !!level.value)
  && exampleText.value.trim().length <= EXAMPLE_MAX_CHARS)

function saveExample() {
  if (!canSaveExample.value || busy.value) return
  exampleAction.value = 'save'
  const text = exampleText.value.trim()
  if (exampleOnly.value) emit('example', text)
  else emit('answer', level.value!, text)
}

function saveWithoutExample() {
  if (!level.value || busy.value) return
  exampleAction.value = 'without'
  emit('answer', level.value, null)
}

// Leave edit mode once a saved answer comes back (a changed answer keeps status 'answered';
// an added example changes only the example).
watch(() => [props.question.status, props.question.answer, props.question.answeredAt, props.question.example], () => {
  editing.value = false
  closeExample()
})

// A failed save leaves the box open with its text; only the spinner choice resets.
watch(() => props.saving, (now) => {
  if (!now) exampleAction.value = null
})

watch(() => (exampleOpen.value ? exampleText.value : showInput.value ? draft.value : ''), text => emit('boxText', text))

// "Use this draft" in the chat: the draft goes into the answer box (or the example box) for Devin to edit and save.
watch(() => props.prefill?.nonce, () => {
  const text = props.prefill?.text
  if (!text || props.mode === 'skipped') return
  recordsMessage.value = null
  pendingRecords.value = null
  recordsDraft.value = props.prefill?.records ?? null
  recordsNote.value = props.prefill?.records ? props.prefill?.memoryNote ?? null : null
  if (takesExample.value) {
    if (props.mode === 'answered' && !editing.value) {
      // Answered No has no example to write.
      if (!answeredWithLevel.value) return
      exampleOnly.value = true
    }
    // From a pending question's draft: the level comes with it, so one tap picks Yes and fills the box.
    const lv = props.prefill?.level
    if (props.mode === 'pending' && lv && isExampleLevel(lv)) level.value = lv
    exampleText.value = text
    exampleOpen.value = true
    return
  }
  if (props.mode === 'answered' || inputType.value === 'long') editing.value = true
  draft.value = text
})

// "Use this" on Found in your GitHub: the same handoff as the chat's "Use this draft". It picks the
// suggested level and puts the draft in the example box. Nothing is saved until Save.
function useRepoSuggestion() {
  const s = props.question.repoSuggestion
  if (!s || props.mode !== 'pending' || busy.value) return
  clearRecords()
  level.value = s.level
  exampleText.value = s.draft
  exampleOpen.value = true
}

// The chat's "Answer: Yes" on a skill or experience question picks it here and opens the example box.
watch(() => props.pick?.nonce, () => {
  const lv = props.pick?.level
  if (!lv || props.mode === 'skipped') return
  if (props.mode === 'answered') {
    if (editing.value === false) startEdit()
  }
  tap(lv)
})
</script>

<template>
  <v-card variant="outlined" class="question-card" :class="{ 'question-card--waiting': mode === 'pending' && waiting > 0 }">
    <v-card-text class="pa-4 pa-sm-5">
      <div class="d-flex flex-wrap align-center ga-2 mb-2">
        <v-chip size="small" variant="tonal" color="secondary" label>{{ kindLabel }}</v-chip>
        <v-chip
          v-if="mode === 'pending' && waiting > 0"
          size="small"
          variant="tonal"
          color="warning"
          prepend-icon="mdi-timer-sand"
          label
        >
          {{ waiting === 1 ? 'An application waits on this' : `${waiting} applications wait on this` }}
        </v-chip>
        <NuxtLink
          v-if="question.job && !(mode === 'pending' && waiters.length)"
          :to="`/jobs/${question.job.id}`"
          class="question-card__job text-caption text-medium-emphasis"
        >
          {{ question.job.title }} at {{ question.job.company }}
        </NuxtLink>
      </div>


      <h3 class="question-card__question text-subtitle-1 font-weight-medium">
        {{ question.question }}
      </h3>
      <p v-if="question.context && !shared && (mode === 'pending' || editing)" class="question-card__context text-body-2 text-medium-emphasis mt-1">
        {{ plainQuestionContext(question.context) }}
      </p>

      <div v-if="mode === 'pending' && waiters.length" class="question-card__waiters">
        <span class="question-card__waiters-label text-caption text-medium-emphasis">Waiting on this</span>
        <NuxtLink v-for="w in waiters" :key="w.id" :to="`/review/${w.id}`" class="question-card__waiter text-body-2">
          <span class="question-card__waiter-company">{{ w.company }}</span>
          <span class="question-card__waiter-title text-medium-emphasis">{{ w.title }}</span>
        </NuxtLink>
      </div>

      <!-- Suggested from his own commits. Silent when there is nothing: no evidence is never a No. -->
      <QuestionsRepoEvidence
        v-if="mode === 'pending' && takesExample && question.repoSuggestion"
        :suggestion="question.repoSuggestion"
        :disabled="busy"
        :box-text="exampleOpen ? exampleText : ''"
        @use="useRepoSuggestion"
      />

      <QuestionsMemoryLeads v-if="mode === 'pending'" :question-id="question.id" :takes-example="takesExample" @ask="emit('ask')" />

      <!-- Answered: what was saved and where -->
      <div v-if="mode === 'answered' && !editing" class="question-card__answer mt-3">
        <div class="text-body-2 question-card__answer-text">
          <div>{{ shownAnswer }}</div>
          <div v-if="question.example && !exampleOnly" class="question-card__example-saved">
            <div class="text-caption text-medium-emphasis">Your example</div>
            <div class="question-card__example-saved-text">{{ question.example }}</div>
          </div>
        </div>
        <div v-if="answeredWithLevel && !exampleOnly" class="question-card__example-row">
          <span v-if="missingExample" class="text-body-2 text-medium-emphasis question-card__example-missing">
            No example yet, so the resume and letter can only make a bare claim.
          </span>
          <v-btn
            :variant="missingExample ? 'tonal' : 'text'"
            :color="missingExample ? 'primary' : undefined"
            :prepend-icon="missingExample ? 'mdi-plus' : 'mdi-pencil-outline'"
            height="44"
            class="question-card__example-start"
            :disabled="busy"
            @click="startExample"
          >
            {{ missingExample ? 'Add an example' : 'Edit example' }}
          </v-btn>
        </div>
        <div v-if="savedAs" class="text-caption text-medium-emphasis mt-1">
          <v-icon icon="mdi-database-check-outline" size="14" class="mr-1" />Saved to your knowledge base as {{ savedAs }}
        </div>
      </div>

      <!-- Answer controls -->
      <div v-if="showInput" class="mt-4">
        <div v-if="inputType === 'yes_no'" class="question-card__taps d-flex flex-wrap ga-2">
          <v-btn
            v-for="opt in yesNoOptions"
            :key="opt"
            :color="isChosen(opt) ? 'primary' : undefined"
            :variant="isChosen(opt) ? 'outlined' : 'tonal'"
            :prepend-icon="isChosen(opt) ? 'mdi-check' : undefined"
            :aria-pressed="isChosen(opt)"
            :loading="saving === opt && !exampleOpen"
            :disabled="busy && saving !== opt"
            class="question-card__tap"
            @click="tap(opt)"
          >
            {{ opt }}
          </v-btn>
        </div>

        <div v-else-if="inputType === 'choice'" class="question-card__taps d-flex flex-wrap ga-2">
          <v-btn
            v-for="opt in question.choices!"
            :key="opt"
            :color="isCurrent(opt) ? 'primary' : undefined"
            :variant="isCurrent(opt) ? 'outlined' : 'tonal'"
            :prepend-icon="isCurrent(opt) ? 'mdi-check' : undefined"
            :aria-pressed="isCurrent(opt)"
            :loading="saving === opt"
            :disabled="busy && saving !== opt"
            class="question-card__tap"
            @click="send(opt)"
          >
            {{ opt }}
          </v-btn>
        </div>

        <form v-else-if="inputType === 'number'" class="d-flex flex-wrap align-start ga-2" @submit.prevent="numberValid && send(draft)">
          <v-text-field
            v-model="draft"
            :prefix="isComp ? '$' : undefined"
            :suffix="isComp ? 'a year' : undefined"
            :placeholder="isComp ? '150,000' : 'Number'"
            inputmode="numeric"
            autocomplete="off"
            enterkeyhint="done"
            hide-details
            class="question-card__field"
            :disabled="busy"
          />
          <v-btn :color="numberValid ? 'primary' : undefined" :variant="numberValid ? 'flat' : 'tonal'" type="submit" height="48" :loading="busy" :disabled="!numberValid">Save</v-btn>
        </form>

        <!-- Written answers can run to several paragraphs and bullet lines, so the box grows with them.
             Enter adds a line; only Save sends. 4,000 characters is the server's limit. -->
        <div v-else-if="inputType === 'text'" class="d-flex flex-column ga-2">
          <div v-if="recordsDraft" class="question-card__records-label text-body-2">
            <v-icon icon="mdi-file-document-edit-outline" size="16" />{{ RECORDS_DRAFT_LABEL }}
          </div>
          <v-textarea
            v-model="draft"
            placeholder="Your answer"
            rows="3"
            auto-grow
            maxlength="4000"
            counter="4000"
            persistent-counter
            autocomplete="off"
            :disabled="busy"
          />
          <div class="d-flex justify-end">
            <v-btn :color="draft.trim() ? 'primary' : undefined" :variant="draft.trim() ? 'flat' : 'tonal'" height="44" :loading="busy" :disabled="!draft.trim()" @click="send(draft)">Save</v-btn>
          </div>
          <QuestionsRecordsSources v-if="recordsDraft" :draft="recordsDraft" :memory-note="recordsNote" />
        </div>

        <template v-else>
          <v-btn
            v-if="mode === 'pending' && !editing"
            variant="tonal"
            height="44"
            prepend-icon="mdi-pencil-outline"
            @click="startEdit"
          >
            Write an answer
          </v-btn>
          <div v-if="editing" class="d-flex flex-column ga-2">
            <div v-if="recordsDraft" class="question-card__records-label text-body-2">
              <v-icon icon="mdi-file-document-edit-outline" size="16" />{{ RECORDS_DRAFT_LABEL }}
            </div>
            <v-textarea
              v-model="draft"
              placeholder="Answer in your own words. It is stored exactly as you write it."
              rows="3"
              auto-grow
              maxlength="4000"
              hide-details
              autofocus
              :disabled="busy"
            />
            <div class="d-flex justify-end ga-2">
              <v-btn variant="text" height="44" :disabled="busy" @click="cancelEdit">Cancel</v-btn>
              <v-btn :color="draft.trim() ? 'primary' : undefined" :variant="draft.trim() ? 'flat' : 'tonal'"  height="44" :loading="busy" :disabled="!draft.trim()" @click="send(draft)">Save answer</v-btn>
            </div>
            <QuestionsRecordsSources v-if="recordsDraft" :draft="recordsDraft" :memory-note="recordsNote" />
          </div>
        </template>
      </div>

      <!-- After Yes or Some experience: where he did it, in his own words -->
      <div v-if="exampleOpen && (showInput || exampleOnly)" class="question-card__example" role="group" :aria-labelledby="`${exampleBoxId}-label`">
        <label :id="`${exampleBoxId}-label`" :for="exampleBoxId" class="question-card__example-label text-body-1 font-weight-medium">
          Where did you do it?
        </label>
        <p class="question-card__example-hint text-body-2 text-medium-emphasis">
          The job or project, what you did, and the result if there was one. It is saved exactly as you write it.
        </p>
        <p v-if="!level && !exampleOnly" class="question-card__example-pick text-body-2">
          Tap Yes or Some experience above, then save.
        </p>
        <div v-if="recordsDraft" class="question-card__records-label text-body-2">
          <v-icon icon="mdi-file-document-edit-outline" size="16" />{{ RECORDS_DRAFT_LABEL }}
        </div>
        <v-textarea
          :id="exampleBoxId"
          v-model="exampleText"
          rows="3"
          auto-grow
          :maxlength="EXAMPLE_MAX_CHARS"
          :counter="EXAMPLE_MAX_CHARS"
          persistent-counter
          autocomplete="off"
          autofocus
          :disabled="busy"
          class="question-card__example-box"
        />
        <div class="question-card__example-actions">
          <v-btn
            :color="canSaveExample ? 'primary' : undefined"
            :variant="canSaveExample ? 'flat' : 'tonal'"
            height="44"
            :loading="busy && exampleAction === 'save'"
            :disabled="!canSaveExample || (busy && exampleAction !== 'save')"
            @click="saveExample"
          >
            Save
          </v-btn>
          <v-btn
            v-if="!exampleOnly"
            variant="text"
            height="44"
            :loading="busy && exampleAction === 'without'"
            :disabled="!level || (busy && exampleAction !== 'without')"
            @click="saveWithoutExample"
          >
            Save without an example
          </v-btn>
          <v-btn v-else variant="text" height="44" :disabled="busy" @click="closeExample">Cancel</v-btn>
        </div>
        <QuestionsRecordsSources v-if="recordsDraft" :draft="recordsDraft" :memory-note="recordsNote" />
      </div>

      <!-- Draft from my records: replace what he typed, or why there is no draft -->
      <div v-if="pendingRecords" class="question-card__records-confirm" role="alert">
        <span class="text-body-2">The draft from your records is ready. Replace what you typed with it?</span>
        <div class="question-card__records-actions">
          <v-btn color="primary" variant="flat" height="44" @click="fillFromRecords(pendingRecords.draft, pendingRecords.note)">Replace</v-btn>
          <v-btn variant="text" height="44" @click="pendingRecords = null">Keep mine</v-btn>
        </div>
      </div>
      <p v-if="recordsMessage" class="question-card__records-message text-body-2" role="status">
        <v-icon icon="mdi-information-outline" size="16" />
        <span>{{ recordsMessage }}</span>
      </p>
    </v-card-text>

    <v-card-actions v-if="mode === 'pending' || mode === 'skipped' || (mode === 'answered' && !(editing && inputType === 'long'))" class="px-4 pb-3 pt-0 question-card__actions">
      <v-btn
        variant="text"
        size="small"
        :color="asking ? 'primary' : undefined"
        prepend-icon="mdi-chat-question-outline"
        :aria-pressed="!!asking"
        class="question-card__ask"
        @click="emit('ask')"
      >
        Ask about this
      </v-btn>
      <v-btn
        v-if="canDraftRecords"
        variant="text"
        size="small"
        color="primary"
        prepend-icon="mdi-file-document-edit-outline"
        class="question-card__records-btn"
        :loading="recordsBusy"
        :disabled="busy"
        @click="draftFromRecords"
      >
        Draft from my records
        <template #loader>
          <v-progress-circular indeterminate size="16" width="2" class="mr-2" />Searching your records
        </template>
      </v-btn>
      <v-spacer />
      <v-btn v-if="mode === 'pending'" variant="text" size="small" prepend-icon="mdi-skip-next" :disabled="busy" @click="emit('skip')">
        Skip
      </v-btn>
      <v-btn v-if="mode === 'skipped'" variant="text" size="small" prepend-icon="mdi-undo" @click="emit('reopen')">
        Ask me again
      </v-btn>
      <template v-if="mode === 'answered'">
        <v-btn v-if="!editing" variant="text" size="small" prepend-icon="mdi-pencil-outline" @click="startEdit">Change answer</v-btn>
        <v-btn v-else variant="text" size="small" :disabled="busy" @click="cancelEdit">Cancel</v-btn>
      </template>
    </v-card-actions>
  </v-card>
</template>

<style scoped lang="scss">
.question-card {
  transition: border-color 0.15s ease;

  &--waiting {
    border-color: rgba(var(--v-theme-warning), 0.45);
  }

  &__question {
    line-height: 1.4;
    text-wrap: pretty;
  }

  &__waiters {
    display: flex;
    flex-direction: column;
    margin-top: 8px;
  }

  &__waiters-label {
    margin-bottom: 2px;
  }

  &__waiter {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    column-gap: 8px;
    min-height: 44px;
    padding: 4px 0;
    text-decoration: none;
    overflow-wrap: anywhere;
    border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));

    @media (min-width: 600px) {
      min-height: 32px;
    }

    &:hover .question-card__waiter-company,
    &:focus-visible .question-card__waiter-company {
      text-decoration: underline;
    }
  }

  &__waiter-company {
    color: rgb(var(--v-theme-primary));
    font-weight: 500;
  }

  &__context {
    max-width: 680px;
    text-wrap: pretty;
  }

  &__job {
    text-decoration: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;

    &:hover {
      text-decoration: underline;
    }
  }

  // Skip, Ask me again, Change answer, and Cancel are small text buttons; keep them 44px tall to tap.
  &__actions :deep(.v-btn) {
    min-height: 44px;
  }

  &__tap {
    min-width: 88px;
    min-height: 44px;
    text-transform: none;
    letter-spacing: normal;
  }

  &__field {
    flex: 1 1 220px;
    min-width: 0;
  }

  &__answer-text {
    white-space: pre-wrap;
    padding: 10px 12px;
    border-radius: 8px;
    background: rgba(var(--v-theme-on-surface), 0.05);
    overflow-wrap: anywhere;
  }

  &__example-saved {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  }

  &__example-saved-text {
    white-space: pre-wrap;
  }

  &__example-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 12px;
    margin-top: 8px;
  }

  &__example-missing {
    flex: 1 1 260px;
    min-width: 0;
  }

  &__example-start {
    text-transform: none;
    letter-spacing: normal;
  }

  &__example {
    margin-top: 16px;
    padding: 14px 16px 12px;
    border-radius: 8px;
    border: 1px solid rgba(var(--v-theme-primary), 0.35);
    background: rgba(var(--v-theme-primary), 0.05);
  }

  &__example-label {
    display: block;
    line-height: 1.4;
  }

  &__example-hint {
    margin: 2px 0 12px;
    line-height: 1.45;
    text-wrap: pretty;
  }

  &__example-pick {
    margin: -4px 0 12px;
    color: rgb(var(--v-theme-warning));
  }

  &__records-label {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 0 8px;
    color: rgb(var(--v-theme-primary));
    font-weight: 500;
  }

  &__records-btn {
    text-transform: none;
    letter-spacing: normal;
  }

  &__records-confirm {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 12px;
    padding: 10px 12px;
    border-radius: 8px;
    background: rgba(var(--v-theme-warning), 0.1);
    border: 1px solid rgba(var(--v-theme-warning), 0.3);
  }

  &__records-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;

    :deep(.v-btn) {
      text-transform: none;
      letter-spacing: normal;
    }
  }

  &__records-message {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    margin-top: 12px;
    line-height: 1.45;

    .v-icon {
      margin-top: 2px;
      flex: 0 0 auto;
      color: rgb(var(--v-theme-info));
    }
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
}

// On a phone the tap targets share the row and grow to fill it, sized by their labels so
// "Some experience" never clips.
@media (max-width: 599px) {
  // The job link sits in the chip row; give it a full-height tap area on a phone.
  .question-card__job {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
  }

  .question-card__taps .question-card__tap {
    flex: 1 1 auto;
    min-width: 64px;
    padding-inline: 12px;
  }
}
</style>

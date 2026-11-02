<script setup lang="ts">
import type { QuestionListItem } from '#shared/types/learning'

// One question on the /questions page. Yes or no questions answer in one tap; choices are one
// tap; numbers and short facts take a field; open-ended questions from the original tailoring
// flow open a text box. The parent sends the answer and removes or moves the card.

const props = defineProps<{
  question: QuestionListItem
  /** Which list the card sits in. */
  mode: 'pending' | 'answered' | 'skipped'
  /** The answer value being saved right now, so only that button spins. */
  saving?: string | null
}>()

const emit = defineEmits<{
  answer: [answer: string]
  skip: []
  reopen: []
}>()

const COMP_FLOOR_SUBJECT = 'compensation floor'

const editing = ref(false)
const draft = ref('')

const isComp = computed(() => props.question.subject === COMP_FLOOR_SUBJECT)
const isExperience = computed(() => props.question.kind === 'knows' || props.question.kind === 'has_done')
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

function startEdit() {
  draft.value = props.question.legacy || props.question.answerType === 'text' ? (props.question.answer ?? '') : ''
  editing.value = true
}

function cancelEdit() {
  editing.value = false
  draft.value = ''
}

function send(value: string) {
  const v = value.trim()
  if (!v || busy.value) return
  emit('answer', v)
}

// Leave edit mode once a saved answer comes back (a changed answer keeps status 'answered').
watch(() => [props.question.status, props.question.answer, props.question.answeredAt], () => {
  editing.value = false
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
          v-if="question.job"
          :to="`/jobs/${question.job.id}`"
          class="question-card__job text-caption text-medium-emphasis"
        >
          {{ question.job.title }} at {{ question.job.company }}
        </NuxtLink>
      </div>

      <h3 class="question-card__question text-subtitle-1 font-weight-medium">
        {{ question.question }}
      </h3>
      <p v-if="question.context && (mode === 'pending' || editing)" class="question-card__context text-body-2 text-medium-emphasis mt-1">
        {{ question.context }}
      </p>

      <!-- Answered: what was saved and where -->
      <div v-if="mode === 'answered' && !editing" class="question-card__answer mt-3">
        <div class="text-body-2 question-card__answer-text">{{ shownAnswer }}</div>
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

        <form v-else-if="inputType === 'text'" class="d-flex flex-wrap align-start ga-2" @submit.prevent="send(draft)">
          <v-text-field
            v-model="draft"
            placeholder="Short answer"
            autocomplete="off"
            enterkeyhint="done"
            maxlength="500"
            class="question-card__field"
            hide-details
            :disabled="busy"
          />
          <v-btn :color="draft.trim() ? 'primary' : undefined" :variant="draft.trim() ? 'flat' : 'tonal'" type="submit" height="48" :loading="busy" :disabled="!draft.trim()">Save</v-btn>
        </form>

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
          </div>
        </template>
      </div>
    </v-card-text>

    <v-card-actions v-if="mode === 'pending' || mode === 'skipped' || (mode === 'answered' && !(editing && inputType === 'long'))" class="px-4 pb-3 pt-0 question-card__actions">
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

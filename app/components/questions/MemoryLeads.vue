<script setup lang="ts">
import { useQuestionChat } from './chat-store'

// "From your Claude sessions": leads the daily run found in Devin's past Claude sessions for one
// pending question. They are leads, never answers: the card shows the date, the project, and one
// quoted line each, and the only action opens the chat with them in context. Nothing here saves
// an answer. Shown on question cards (/questions and the review page) and in the chat panel.

const props = withDefaults(defineProps<{
  questionId: number
  /** A skill or experience question: the chat writes the "Where did you do it?" example. */
  takesExample?: boolean
  /** card: under a question, opens the chat. chat: inside the chat panel, asks there. */
  variant?: 'card' | 'chat'
}>(), { takesExample: false, variant: 'card' })

const emit = defineEmits<{
  /** Open the chat on this question (the card's Ask about this). */
  ask: []
}>()

const { byQuestion, load } = useMemoryLeads()
const chat = useQuestionChat()
const open = ref(false)

const entry = computed(() => byQuestion.value[props.questionId] ?? null)
const leads = computed(() => entry.value?.leads ?? [])
const bodyId = computed(() => `memory-leads-${props.variant}-${props.questionId}`)
const busy = computed(() => !!chat.sending.value[`q${props.questionId}`])

function day(d: string | null): string {
  if (!d) return 'Date unknown'
  const t = new Date(`${d}T12:00:00`)
  return Number.isNaN(t.getTime()) ? d : t.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

const checked = computed(() => {
  const at = entry.value?.checkedAt
  if (!at) return ''
  const t = new Date(at)
  if (Number.isNaN(t.getTime())) return ''
  return t.toDateString() === new Date().toDateString()
    ? `today at ${t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
    : t.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
})

/** Starts the chat with a request that brings the leads into its prompt, then opens it. */
function askWithLeads() {
  if (busy.value) return
  chat.send(props.questionId, props.takesExample
    ? 'Help me write the example from the leads in my Claude sessions.'
    : 'Help me answer this from the leads in my Claude sessions.')
  if (props.variant === 'card') emit('ask')
}

onMounted(() => load())
</script>

<template>
  <div v-if="leads.length" class="memory-leads" :class="`memory-leads--${variant}`">
    <button
      type="button"
      class="memory-leads__toggle"
      :aria-expanded="open"
      :aria-controls="bodyId"
      @click="open = !open"
    >
      <v-icon icon="mdi-history" size="18" class="memory-leads__icon" />
      <span class="memory-leads__title">From your Claude sessions</span>
      <span class="memory-leads__count">{{ leads.length === 1 ? '1 lead' : `${leads.length} leads` }}</span>
      <v-icon :icon="open ? 'mdi-chevron-up' : 'mdi-chevron-down'" size="18" class="memory-leads__chev" />
    </button>
    <v-expand-transition>
      <!-- v-show sits on a plain wrapper so the transition can measure it. -->
      <div v-show="open" :id="bodyId">
        <div class="memory-leads__body">
          <p class="memory-leads__note">
            Leads to jog your memory: what was discussed, researched, or planned in a session. They are not proof of work you did, and nothing here is saved as an answer.
          </p>
          <ul class="memory-leads__list">
            <li v-for="(l, i) in leads" :key="i" class="memory-leads__lead">
              <div class="memory-leads__meta">{{ day(l.date) }} <span aria-hidden="true">·</span> {{ l.project }}</div>
              <div class="memory-leads__line">“{{ l.line }}”</div>
            </li>
          </ul>
          <div class="memory-leads__actions">
            <v-btn
              variant="tonal"
              color="primary"
              height="44"
              prepend-icon="mdi-chat-question-outline"
              class="memory-leads__ask"
              :loading="busy"
              @click="askWithLeads"
            >
              {{ variant === 'card' ? 'Use these in the chat' : 'Ask with these leads' }}
            </v-btn>
            <span v-if="checked" class="memory-leads__checked">Looked up {{ checked }}</span>
          </div>
        </div>
      </div>
    </v-expand-transition>
  </div>
</template>

<style scoped lang="scss">
.memory-leads {
  margin-top: 12px;
  border-radius: 8px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgba(var(--v-theme-on-surface), 0.03);

  &__toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 44px;
    padding: 6px 12px;
    border-radius: 8px;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    background: transparent;
    border: 0;

    &:hover {
      background: rgba(var(--v-theme-on-surface), 0.04);
    }

    &:focus-visible {
      outline: 2px solid rgb(var(--v-theme-primary));
      outline-offset: -2px;
    }
  }

  &__icon {
    color: rgb(var(--v-theme-secondary));
  }

  &__title {
    font-size: 0.875rem;
    font-weight: 500;
  }

  &__count {
    font-size: 0.8125rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    font-variant-numeric: tabular-nums;
  }

  &__chev {
    margin-left: auto;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__body {
    padding: 0 12px 12px;
  }

  &__note {
    margin: 0 0 8px;
    font-size: 0.8125rem;
    line-height: 1.45;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    text-wrap: pretty;
  }

  &__list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  &__lead {
    padding: 8px 0;
    border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    overflow-wrap: anywhere;
  }

  &__meta {
    font-size: 0.75rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    margin-bottom: 2px;
  }

  &__line {
    font-size: 0.875rem;
    line-height: 1.45;
  }

  &__actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 12px;
    margin-top: 8px;
  }

  &__ask {
    text-transform: none;
    letter-spacing: normal;
  }

  &__checked {
    font-size: 0.75rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  // Inside the chat panel's "About this question" block: tighter, no outer gap.
  &--chat {
    margin-top: 8px;
  }
}
</style>

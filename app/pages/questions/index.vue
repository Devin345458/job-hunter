<script setup lang="ts">
import { useDisplay } from 'vuetify'
import type { AnswerOutcome, QuestionListItem } from '#shared/types/learning'
import { saveChatQuestionId, savedChatQuestionId } from '~/components/questions/chat-store'

definePageMeta({ layout: 'default' })

const snackbar = useSnackbar()
const { xs } = useDisplay()

const all = ref<QuestionListItem[]>([])
const loading = ref(true)
const loadError = ref<string | null>(null)
const saving = ref<Record<number, string | null>>({})
const showAnswered = ref(false)
const showSkipped = ref(false)

const pending = computed(() => all.value.filter(q => q.status === 'pending'))
const waitingOnYou = computed(() => pending.value.filter(q => q.waitingApplicationIds.length > 0 || q.blocking))
const quick = computed(() => pending.value.filter(q => !q.legacy && !(q.waitingApplicationIds.length > 0 || q.blocking)))
const legacy = computed(() => pending.value.filter(q => q.legacy && !(q.waitingApplicationIds.length > 0 || q.blocking)))
const answered = computed(() => all.value.filter(q => q.status === 'answered').sort((a, b) => (b.answeredAt ?? '').localeCompare(a.answeredAt ?? '')))
const skipped = computed(() => all.value.filter(q => q.status === 'skipped'))

// ── Ask Claude ──
// 1280px and wider: the chat sits in a sticky column beside the list. Narrower: Ask about this
// opens it in a dialog (full screen on a phone). Both show the same conversations.
const WIDE_QUERY = '(min-width: 1280px)'
const chatQuestionId = ref<number | null>(null)
const chatOpen = ref(false)
const chatPanel = ref<{ focus: () => void } | null>(null)
/** Drafts sent to a card's answer box by "Use this draft", keyed by question id. */
const prefills = ref<Record<number, { text: string; nonce: number }>>({})
/** What each card's open answer box holds, so "Use this draft" asks before replacing typed text. */
const boxTexts = ref<Record<number, string>>({})
const chatQuestion = computed(() => all.value.find(q => q.id === chatQuestionId.value) ?? null)

function isWide() {
  return import.meta.client && window.matchMedia(WIDE_QUERY).matches
}

function selectChat(id: number | null) {
  chatQuestionId.value = id
  saveChatQuestionId(id)
}

function askAbout(q: QuestionListItem) {
  selectChat(q.id)
  if (isWide()) nextTick(() => chatPanel.value?.focus())
  else chatOpen.value = true
}

function askGeneral() {
  selectChat(null)
  if (isWide()) nextTick(() => chatPanel.value?.focus())
  else chatOpen.value = true
}

function answerFromChat(value: string) {
  const q = chatQuestion.value
  if (q) answer(q, value)
}

function useDraft(text: string) {
  const q = chatQuestion.value
  if (!q) return
  prefills.value = { ...prefills.value, [q.id]: { text, nonce: Date.now() } }
  chatOpen.value = false
  if (q.status === 'answered') showAnswered.value = true
  nextTick(() => {
    document.getElementById(`question-${q.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  })
  snackbar.info('The draft is in the answer box. Edit it, then press Save.')
}

async function load() {
  loadError.value = null
  try {
    const data = await $fetch<{ questions: QuestionListItem[] }>('/api/questions')
    all.value = data.questions
  }
  catch (e: any) {
    loadError.value = e?.data?.statusMessage || e?.message || 'Could not load questions'
  }
  finally {
    loading.value = false
  }
}

function replace(item: QuestionListItem) {
  const i = all.value.findIndex(q => q.id === item.id)
  if (i >= 0) all.value[i] = item
  else all.value.push(item)
}

function where(key: string) {
  const i = key.indexOf(':')
  return i > 0 ? `${key.slice(0, i)}: ${key.slice(i + 1)}` : key
}

async function answer(q: QuestionListItem, value: string) {
  saving.value[q.id] = value
  try {
    const out = await $fetch<AnswerOutcome>(`/api/questions/${q.id}`, {
      method: 'PATCH',
      body: { status: 'answered', answer: value },
    })
    replace(out.question)
    // Keys made from a form label can end in a period already ("...professionally or personally.").
    const parts = [`Saved to your knowledge base as ${where(`${out.knowledge!.category}:${out.knowledge!.key}`).replace(/[.\s]+$/, '')}.`]
    if (out.refreshedApplicationIds.length) parts.push(`${out.refreshedApplicationIds.length === 1 ? 'One application was' : `${out.refreshedApplicationIds.length} applications were`} updated.`)
    else if (out.refreshUnavailable) parts.push('Waiting applications pick it up once form answers can refresh.')
    if (out.rescored) parts.push(`${out.rescored} ${out.rescored === 1 ? 'job' : 'jobs'} rescored.`)
    snackbar.success(parts.join(' '))
  }
  catch (e: any) {
    snackbar.error(e?.data?.statusMessage || 'Could not save that answer. Try again.')
  }
  finally {
    saving.value[q.id] = null
  }
}

async function skip(q: QuestionListItem) {
  try {
    const out = await $fetch<{ question: QuestionListItem }>(`/api/questions/${q.id}`, { method: 'PATCH', body: { status: 'skipped' } })
    replace(out.question)
    snackbar.info('Skipped. It is under Skipped if you want it back.', { text: 'Undo', handler: () => reopen(out.question) })
  }
  catch (e: any) {
    snackbar.error(e?.data?.statusMessage || 'Could not skip that question')
  }
}

async function reopen(q: QuestionListItem) {
  try {
    const out = await $fetch<{ question: QuestionListItem }>(`/api/questions/${q.id}`, { method: 'PATCH', body: { status: 'pending' } })
    replace(out.question)
  }
  catch (e: any) {
    snackbar.error(e?.data?.statusMessage || 'Could not bring that question back')
  }
}

onMounted(async () => {
  await load()
  const saved = savedChatQuestionId()
  if (saved && all.value.some(q => q.id === saved)) chatQuestionId.value = saved
})
</script>

<template>
  <div class="fade-in questions-page">
    <div class="questions-page__main">
      <div class="d-flex flex-wrap align-start justify-space-between ga-4 mb-8">
        <div class="page-header mb-0">
          <h1 class="text-h4 page-header__title">Questions</h1>
          <p class="text-body-2 page-header__subtitle">
            What the pipeline needs to know about you. Every answer goes into your knowledge base, a No included,
            so nothing is ever claimed on an application that you have not confirmed.
          </p>
        </div>
        <div class="d-flex flex-wrap align-center ga-2">
          <v-chip v-if="pending.length" variant="tonal" color="warning" class="questions-page__count">
            {{ pending.length }} to answer
          </v-chip>
          <v-btn
            variant="tonal"
            prepend-icon="mdi-chat-question-outline"
            class="questions-page__ask"
            @click="askGeneral"
          >
            Ask Claude
          </v-btn>
        </div>
      </div>

      <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-6" />

      <v-alert v-if="loadError" type="error" variant="tonal" class="mb-6">
        {{ loadError }}
        <template #append>
          <v-btn variant="text" height="44" @click="load">Try again</v-btn>
        </template>
      </v-alert>

      <template v-if="!loading && !loadError">
        <!-- Applications are waiting -->
        <section v-if="waitingOnYou.length" class="mb-8">
          <div class="section-label questions-page__label">Waiting on you</div>
          <p class="text-body-2 text-medium-emphasis questions-page__section-note">
            Applications in your review queue use these answers. The ones marked as blocking keep Approve locked until you answer.
          </p>
          <div class="d-flex flex-column ga-3">
            <KnowledgeQuestionCard
              v-for="q in waitingOnYou"
              :key="q.id"
              :id="`question-${q.id}`"
              :question="q"
              mode="pending"
              :saving="saving[q.id]"
              :asking="chatQuestionId === q.id"
              :prefill="prefills[q.id]"
              @answer="v => answer(q, v)"
              @skip="skip(q)"
              @ask="askAbout(q)"
              @box-text="t => (boxTexts[q.id] = t)"
            />
          </div>
        </section>

        <!-- One-tap and short answers -->
        <section v-if="quick.length" class="mb-8">
          <div class="section-label questions-page__label">Quick answers</div>
          <p class="text-body-2 text-medium-emphasis questions-page__section-note">
            No application is waiting on these. They come from skills that keep showing up in open jobs; each answer makes future matches and resumes more accurate.
          </p>
          <div class="d-flex flex-column ga-3">
            <KnowledgeQuestionCard
              v-for="q in quick"
              :key="q.id"
              :id="`question-${q.id}`"
              :question="q"
              mode="pending"
              :saving="saving[q.id]"
              :asking="chatQuestionId === q.id"
              :prefill="prefills[q.id]"
              @answer="v => answer(q, v)"
              @skip="skip(q)"
              @ask="askAbout(q)"
              @box-text="t => (boxTexts[q.id] = t)"
            />
          </div>
        </section>

        <!-- Open-ended questions from the original resume tailoring flow -->
        <section v-if="legacy.length" class="mb-8">
          <div class="section-label">From earlier resume tailoring ({{ legacy.length }})</div>
          <p class="text-body-2 text-medium-emphasis mb-4 questions-page__note">
            Open-ended questions the old tailoring step asked. Answer any you like in your own words. Your words are stored as written.
          </p>
          <div class="d-flex flex-column ga-3">
            <KnowledgeQuestionCard
              v-for="q in legacy"
              :key="q.id"
              :id="`question-${q.id}`"
              :question="q"
              mode="pending"
              :saving="saving[q.id]"
              :asking="chatQuestionId === q.id"
              :prefill="prefills[q.id]"
              @answer="v => answer(q, v)"
              @skip="skip(q)"
              @ask="askAbout(q)"
              @box-text="t => (boxTexts[q.id] = t)"
            />
          </div>
        </section>

        <!-- Nothing pending -->
        <v-card v-if="pending.length === 0" variant="outlined" class="text-center pa-10 mb-8">
          <v-icon icon="mdi-check-circle-outline" size="48" color="success" class="mb-3" />
          <h2 class="text-h6 mb-1">Nothing to answer</h2>
          <p class="text-body-2 text-medium-emphasis mx-auto questions-page__note">
            New questions appear when a job asks for something your knowledge base does not cover, or an application form needs a fact only you know.
          </p>
        </v-card>

        <!-- Answered -->
        <section v-if="answered.length" class="mb-4">
          <v-btn
            variant="text"
            class="px-1 mb-2 text-medium-emphasis questions-page__toggle"
            :prepend-icon="showAnswered ? 'mdi-chevron-down' : 'mdi-chevron-right'"
            :aria-expanded="showAnswered"
            aria-controls="questions-answered"
            @click="showAnswered = !showAnswered"
          >
            Answered ({{ answered.length }})
          </v-btn>
          <v-expand-transition>
            <!-- v-show sits on a plain wrapper: .d-flex is display: flex !important and would beat it. -->
            <div v-show="showAnswered" id="questions-answered">
              <div class="d-flex flex-column ga-3">
                <KnowledgeQuestionCard
                  v-for="q in answered"
                  :key="q.id"
                  :id="`question-${q.id}`"
                  :question="q"
                  mode="answered"
                  :saving="saving[q.id]"
                  :asking="chatQuestionId === q.id"
                  :prefill="prefills[q.id]"
                  @answer="v => answer(q, v)"
                  @ask="askAbout(q)"
                  @box-text="t => (boxTexts[q.id] = t)"
                />
              </div>
            </div>
          </v-expand-transition>
        </section>

        <!-- Skipped -->
        <section v-if="skipped.length" class="mb-4">
          <v-btn
            variant="text"
            class="px-1 mb-2 text-medium-emphasis questions-page__toggle"
            :prepend-icon="showSkipped ? 'mdi-chevron-down' : 'mdi-chevron-right'"
            :aria-expanded="showSkipped"
            aria-controls="questions-skipped"
            @click="showSkipped = !showSkipped"
          >
            Skipped ({{ skipped.length }})
          </v-btn>
          <v-expand-transition>
            <!-- v-show sits on a plain wrapper: .d-flex is display: flex !important and would beat it. -->
            <div v-show="showSkipped" id="questions-skipped">
              <div class="d-flex flex-column ga-3">
                <KnowledgeQuestionCard
                  v-for="q in skipped"
                  :key="q.id"
                  :id="`question-${q.id}`"
                  :question="q"
                  mode="skipped"
                  :asking="chatQuestionId === q.id"
                  @reopen="reopen(q)"
                  @ask="askAbout(q)"
                  @box-text="t => (boxTexts[q.id] = t)"
                />
              </div>
            </div>
          </v-expand-transition>
        </section>
      </template>
    </div>

    <!-- Wide screens: the chat beside the list -->
    <aside class="questions-page__chat">
      <QuestionsChatPanel
        ref="chatPanel"
        variant="panel"
        :question="chatQuestion"
        :saving="chatQuestion ? saving[chatQuestion.id] : null"
        :box-text="chatQuestion ? boxTexts[chatQuestion.id] : ''"
        @answer="answerFromChat"
        @use-draft="useDraft"
        @detach="selectChat(null)"
      />
    </aside>

    <!-- Narrower screens: the chat in a dialog, full screen on a phone -->
    <v-dialog
      v-model="chatOpen"
      :fullscreen="xs"
      max-width="560"
      class="questions-page__dialog"
      aria-label="Ask Claude"
    >
      <QuestionsChatPanel
        variant="dialog"
        class="questions-page__dialog-panel"
        :question="chatQuestion"
        :saving="chatQuestion ? saving[chatQuestion.id] : null"
        :box-text="chatQuestion ? boxTexts[chatQuestion.id] : ''"
        @answer="answerFromChat"
        @use-draft="useDraft"
        @detach="selectChat(null)"
        @close="chatOpen = false"
      />
    </v-dialog>
  </div>
</template>

<style scoped lang="scss">
.questions-page {
  max-width: 880px;

  // Wide screens: list on the left, the chat in a sticky column on the right.
  @media (min-width: 1280px) {
    max-width: none;
    display: grid;
    grid-template-columns: minmax(0, 880px) clamp(340px, 28vw, 440px);
    column-gap: 24px;
    align-items: start;
  }

  &__main {
    min-width: 0;
  }

  &__chat {
    display: none;

    @media (min-width: 1280px) {
      display: block;
      position: sticky;
      top: 28px;
      height: calc(100vh - 56px);
      height: calc(100dvh - 56px);
    }
  }

  // The chat is always on screen at 1280 and wider, so the button that opens it is not needed there.
  &__ask {
    min-height: 44px;
    text-transform: none;
    letter-spacing: normal;

    @media (min-width: 1280px) {
      display: none;
    }
  }

  &__label {
    margin-bottom: 4px;
  }

  &__section-note {
    margin-bottom: 16px;
    line-height: 1.5;
  }

  &__note {
    max-width: 600px;
  }

  &__count {
    font-variant-numeric: tabular-nums;
  }

  &__toggle {
    min-height: 44px;
  }
}
</style>

<style lang="scss">
// The dialog content is teleported out of the page, so these rules cannot be scoped.
.v-dialog.questions-page__dialog .question-chat.questions-page__dialog-panel {
  height: min(720px, calc(100dvh - 48px));
}

.v-dialog.questions-page__dialog.v-dialog--fullscreen .question-chat.questions-page__dialog-panel {
  height: 100%;
  height: 100dvh;
}
</style>

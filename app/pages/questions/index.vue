<script setup lang="ts">
import { useDisplay } from 'vuetify'
import type { AnswerOutcome, QuestionListItem } from '#shared/types/learning'
import type { RecordsDraft } from '#shared/types/question-chat'
import { EXAMPLE_LEVELS, chatThreadKey, saveChatQuestionId, savedChatQuestionId, useQuestionChat, type DraftMeta } from '~/components/questions/chat-store'
import { countText } from '#shared/utils/pay-format'

definePageMeta({ layout: 'default' })

const snackbar = useSnackbar()
const { xs } = useDisplay()

const all = ref<QuestionListItem[]>([])
const loading = ref(true)
const loadError = ref<string | null>(null)
const saving = ref<Record<number, string | null>>({})
const showAnswered = ref(false)
const showSkipped = ref(false)
const showAppSkipped = ref(false)

const pending = computed(() => all.value.filter(q => q.status === 'pending'))
/** First on the page: the questions that hold an approval until they are answered. */
const waitingOnYou = computed(() => pending.value.filter(q => q.blocking))
const blockingCount = computed(() => waitingOnYou.value.length)
/** Waited on by an application but not holding it up: they lead the rest, most waited on first. */
const waitingSoft = computed(() => pending.value.filter(q => !q.blocking && q.waitingApplicationIds.length > 0)
  .sort((a, b) => b.waitingApplicationIds.length - a.waitingApplicationIds.length))
const quick = computed(() => pending.value.filter(q => !q.legacy && !(q.waitingApplicationIds.length > 0 || q.blocking)))
const legacy = computed(() => pending.value.filter(q => q.legacy && !(q.waitingApplicationIds.length > 0 || q.blocking)))

// ── One page at a time ──
// 232 open questions used to render as one 129-screen page. Now: what applications wait on, then a
// page of ten, then the rest grouped by what they ask about with their counts, ten at a time.
const PAGE = 10
const NEXT_UP = 10
const limits = ref<Record<string, number>>({})
function shown<T>(key: string, list: T[]): T[] {
  return list.slice(0, limits.value[key] ?? PAGE)
}
function showMore(key: string) {
  limits.value = { ...limits.value, [key]: (limits.value[key] ?? PAGE) + PAGE }
}

/** Not waited on by any application, in the order the pipeline asks them: the queue after the blocking ones. */
const rest = computed(() => [...waitingSoft.value, ...quick.value, ...legacy.value])
const nextUp = computed(() => rest.value.slice(0, NEXT_UP))

type GroupKey = 'skill' | 'experience' | 'about' | 'legacy'
const GROUP_TITLE: Record<GroupKey, string> = {
  skill: 'Skills',
  experience: 'Experience',
  about: 'About you',
  legacy: 'From earlier resume tailoring',
}
/** The section a question's answer is filed under (the same rule as the card's label). */
function groupOf(q: QuestionListItem): GroupKey {
  if (q.legacy) return 'legacy'
  const section = (q.knowledgeKey ?? '').split(':')[0]
  if (q.kind === 'knows' || q.kind === 'has_done') {
    if (section === 'skill') return 'skill'
    if (section === 'experience') return 'experience'
    return q.kind === 'knows' ? 'skill' : 'experience'
  }
  return 'about'
}
const groups = computed(() => {
  const later = rest.value.slice(NEXT_UP)
  return (Object.keys(GROUP_TITLE) as GroupKey[])
    .map(key => ({ key, title: GROUP_TITLE[key], items: later.filter(q => groupOf(q) === key) }))
    .filter(g => g.items.length)
})
const openGroups = ref<string[]>([])
function toggleGroup(key: string) {
  openGroups.value = openGroups.value.includes(key) ? openGroups.value.filter(k => k !== key) : [...openGroups.value, key]
}

// Find any open question by its words or subject.
const find = ref('')
const found = computed(() => {
  const t = find.value.trim().toLowerCase()
  if (!t) return []
  return pending.value.filter(q => `${q.question} ${q.subject ?? ''}`.toLowerCase().includes(t))
})
watch(find, () => { limits.value = { ...limits.value, found: PAGE } })
const answered = computed(() => all.value.filter(q => q.status === 'answered').sort((a, b) => (b.answeredAt ?? '').localeCompare(a.answeredAt ?? '')))
// Questions the app skipped (a duplicate, a subject the knowledge base covers, not a skill) carry
// its note and are listed apart, so Skipped by you holds only Devin's own skips.
const skipped = computed(() => all.value.filter(q => q.status === 'skipped' && q.skippedBy !== 'app'))
const appSkipped = computed(() => all.value.filter(q => q.status === 'skipped' && q.skippedBy === 'app'))

// ── Examples ("Where did you do it?") on Yes and Some experience answers ──
const isExampleLevel = (answer: string | null) => !!answer && (EXAMPLE_LEVELS as readonly string[]).includes(answer)
/** Answered Yes or Some experience on a skill or experience question, with no example yet. */
const missingExample = computed(() => answered.value.filter(q => q.takesExample && !q.legacy && isExampleLevel(q.answer) && !q.example))
/** Answered shows only the ones missing an example. */
const onlyMissing = ref(false)
const answeredShown = computed(() => onlyMissing.value ? missingExample.value : answered.value)

function toggleOnlyMissing() {
  onlyMissing.value = !onlyMissing.value
  if (onlyMissing.value) showAnswered.value = true
}

watch(() => missingExample.value.length, (n) => {
  if (n === 0) onlyMissing.value = false
})

// ── Ask Claude ──
// 1280px and wider: the chat sits in a sticky column beside the list. Narrower: Ask about this
// opens it in a dialog (full screen on a phone). Both show the same conversations.
const WIDE_QUERY = '(min-width: 1280px)'
const chatQuestionId = ref<number | null>(null)
const chatOpen = ref(false)
const chatPanel = ref<{ focus: () => void } | null>(null)
/** Drafts sent to a card's answer box by "Use this draft", keyed by question id. */
const prefills = ref<Record<number, { text: string; nonce: number; level?: string | null; records?: RecordsDraft | null; memoryNote?: string | null }>>({})
/** What each card's open answer box holds, so "Use this draft" asks before replacing typed text. */
const boxTexts = ref<Record<number, string>>({})
/** The chat's "Answer: Yes" on a skill or experience question, keyed by question id: the card picks it and opens the example box. */
const picks = ref<Record<number, { level: string; nonce: number }>>({})
const chatQuestion = computed(() => all.value.find(q => q.id === chatQuestionId.value) ?? null)
// With no question picked and no general conversation, the rail is only as tall as its prompt.
const chatStore = useQuestionChat()
const chatInUse = computed(() => chatQuestionId.value != null || (chatStore.threads.value[chatThreadKey(null)]?.length ?? 0) > 0)

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

/**
 * Puts a question's card on the page before the chat hands it a draft or a pick: the card watches
 * for them only while it is mounted, and with paging it may sit in a closed group or a later page.
 */
function reveal(id: number) {
  const q = all.value.find(x => x.id === id)
  if (!q) return
  const pageFor = (i: number) => Math.ceil((i + 1) / PAGE) * PAGE
  if (q.status === 'pending') {
    if (find.value.trim() && found.value.some(x => x.id === id)) {
      const i = found.value.findIndex(x => x.id === id)
      limits.value = { ...limits.value, found: Math.max(limits.value.found ?? PAGE, pageFor(i)) }
      return
    }
    find.value = ''
    for (const g of groups.value) {
      const i = g.items.findIndex(x => x.id === id)
      if (i < 0) continue
      if (!openGroups.value.includes(g.key)) openGroups.value = [...openGroups.value, g.key]
      limits.value = { ...limits.value, [g.key]: Math.max(limits.value[g.key] ?? PAGE, pageFor(i)) }
    }
    return
  }
  if (q.status === 'answered') {
    showAnswered.value = true
    const i = answeredShown.value.findIndex(x => x.id === id)
    if (i >= 0) limits.value = { ...limits.value, answered: Math.max(limits.value.answered ?? PAGE, pageFor(i)) }
  }
}

function scrollToCard(id: number) {
  nextTick(() => {
    document.getElementById(`question-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  })
}

function answerFromChat(value: string) {
  const q = chatQuestion.value
  if (!q) return
  // Yes or Some experience on a skill or experience question waits for the example box on the card.
  if (q.takesExample && !q.legacy && isExampleLevel(value) && q.status === 'pending') {
    reveal(q.id)
    chatOpen.value = false
    nextTick(() => {
      picks.value = { ...picks.value, [q.id]: { level: value, nonce: Date.now() } }
      scrollToCard(q.id)
    })
    return
  }
  answer(q, value)
}

function useDraft(text: string, level: string | null = null, meta?: DraftMeta) {
  const q = chatQuestion.value
  if (!q) return
  chatOpen.value = false
  if (q.status === 'answered') {
    showAnswered.value = true
    if (onlyMissing.value && !missingExample.value.some(x => x.id === q.id)) onlyMissing.value = false
  }
  reveal(q.id)
  nextTick(() => {
    prefills.value = { ...prefills.value, [q.id]: { text, nonce: Date.now(), level, records: meta?.records ?? null, memoryNote: meta?.memoryNote ?? null } }
    scrollToCard(q.id)
  })
  const what = meta?.records ? 'draft from your records' : 'draft'
  snackbar.info(q.takesExample && !q.legacy
    ? `${level ? `${level} is picked and the` : 'The'} ${what} is in the example box. Edit it, then press Save.`
    : `The ${what} is in the answer box. Edit it, then press Save.`)
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

/** example: text sets it, null saves without one (clearing a saved one), undefined keeps the saved one. */
async function answer(q: QuestionListItem, value: string, example?: string | null) {
  saving.value[q.id] = value
  try {
    const out = await $fetch<AnswerOutcome>(`/api/questions/${q.id}`, {
      method: 'PATCH',
      body: { status: 'answered', answer: value, ...(example !== undefined ? { example } : {}) },
    })
    replace(out.question)
    // Keys made from a form label can end in a period already ("...professionally or personally.").
    const parts = [`Saved${out.question.example ? ' with your example' : ''} to your knowledge base as ${where(`${out.knowledge!.category}:${out.knowledge!.key}`).replace(/[.\s]+$/, '')}.`]
    // The same subject asked another way took this answer too: reload so those cards move to Answered.
    if (out.carried?.length) {
      parts.push(`This also answered ${out.carried.map(c => `#${c.id}`).join(', ')}.`)
      await load()
    }
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

async function saveExample(q: QuestionListItem, text: string) {
  saving.value[q.id] = 'example'
  try {
    const out = await $fetch<AnswerOutcome>(`/api/questions/${q.id}`, { method: 'PATCH', body: { example: text } })
    replace(out.question)
    snackbar.success(`Example saved to your knowledge base as ${where(`${out.knowledge!.category}:${out.knowledge!.key}`).replace(/[.\s]+$/, '')}.`)
  }
  catch (e: any) {
    snackbar.error(e?.data?.statusMessage || 'Could not save that example. Try again.')
  }
  finally {
    saving.value[q.id] = null
  }
}

async function skip(q: QuestionListItem) {
  try {
    const out = await $fetch<{ question: QuestionListItem }>(`/api/questions/${q.id}`, { method: 'PATCH', body: { status: 'skipped' } })
    replace(out.question)
    snackbar.info('Skipped. It is under Skipped by you if you want it back.', { text: 'Undo', handler: () => reopen(out.question) })
  }
  catch (e: any) {
    snackbar.error(e?.data?.statusMessage || 'Could not skip that question')
  }
}

async function reopen(q: QuestionListItem) {
  try {
    const out = await $fetch<{ question: QuestionListItem }>(`/api/questions/${q.id}`, { method: 'PATCH', body: { status: 'pending' } })
    replace(out.question)
    if (q.answeredFrom) snackbar.info(`Undone. #${q.id} is open again, and the app will not answer it from another question again.`)
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
      <div class="page-header page-header--split">
        <div>
          <h1 class="text-h4 page-header__title">Questions</h1>
          <p v-if="!loading" class="page-header__subtitle">
            <span class="questions-page__blocking">{{ countText(pending.length) }} open</span><template v-if="blockingCount">, <span class="questions-page__blocking">{{ countText(blockingCount) }} {{ blockingCount === 1 ? 'blocks' : 'block' }} an approval</span></template>
          </p>
        </div>
        <v-btn
          variant="outlined"
          prepend-icon="mdi-chat-question-outline"
          class="questions-page__ask"
          @click="askGeneral"
        >
          Ask Claude
        </v-btn>
      </div>

      <v-progress-linear v-if="loading" indeterminate color="primary" height="2" class="mb-6" />

      <v-alert v-if="loadError" type="error" variant="tonal" class="mb-6">
        {{ loadError }}
        <template #append>
          <v-btn variant="text" height="44" @click="load">Try again</v-btn>
        </template>
      </v-alert>

      <template v-if="!loading && !loadError">
        <!-- The promise, read where answers are given. -->
        <p v-if="pending.length" class="questions-page__promise">
          Every answer is saved to your knowledge base, a No included. Nothing is claimed on an application that you have not confirmed.
        </p>

        <v-text-field
          v-if="pending.length > PAGE"
          v-model="find"
          class="questions-page__find"
          placeholder="Find an open question"
          aria-label="Find an open question"
          prepend-inner-icon="mdi-magnify"
          clearable
          hide-details
        />

        <!-- Found: every open question whose words match, ten at a time. -->
        <section v-if="find.trim()" class="questions-page__section" aria-labelledby="q-found">
          <h2 id="q-found" class="questions-page__h">Found <span class="questions-page__n">{{ countText(found.length) }}</span></h2>
          <p v-if="!found.length" class="questions-page__empty">No open question has those words.</p>
          <div class="questions-page__cards">
            <KnowledgeQuestionCard
              v-for="q in shown('found', found)"
              :key="q.id"
              :id="`question-${q.id}`"
              :question="q"
              mode="pending"
              :saving="saving[q.id]"
              :asking="chatQuestionId === q.id"
              :prefill="prefills[q.id]"
              :pick="picks[q.id]"
              @answer="(v, ex) => answer(q, v, ex)"
              @skip="skip(q)"
              @ask="askAbout(q)"
              @box-text="t => (boxTexts[q.id] = t)"
            />
          </div>
          <v-btn v-if="found.length > shown('found', found).length" variant="outlined" class="questions-page__more" @click="showMore('found')">
            Show {{ Math.min(PAGE, found.length - shown('found', found).length) }} more of {{ countText(found.length - shown('found', found).length) }}
          </v-btn>
        </section>

        <template v-else>
          <!-- Applications are waiting: the ones that block an approval first. -->
          <section v-if="waitingOnYou.length" class="questions-page__section" aria-labelledby="q-waiting">
            <h2 id="q-waiting" class="questions-page__h">Blocking an approval <span class="questions-page__n questions-page__blocking">{{ countText(waitingOnYou.length) }}</span></h2>
            <div class="questions-page__cards">
              <KnowledgeQuestionCard
                v-for="q in waitingOnYou"
                :key="q.id"
                :id="`question-${q.id}`"
                :question="q"
                mode="pending"
                :saving="saving[q.id]"
                :asking="chatQuestionId === q.id"
                :prefill="prefills[q.id]"
                :pick="picks[q.id]"
                @answer="(v, ex) => answer(q, v, ex)"
                @skip="skip(q)"
                @ask="askAbout(q)"
                @box-text="t => (boxTexts[q.id] = t)"
              />
            </div>
          </section>

          <!-- The next ten no application waits on. -->
          <section v-if="nextUp.length" class="questions-page__section" aria-labelledby="q-next">
            <h2 id="q-next" class="questions-page__h">Next up <span class="questions-page__n">{{ countText(nextUp.length) }} of {{ countText(rest.length) }}</span></h2>
            <div class="questions-page__cards">
              <KnowledgeQuestionCard
                v-for="q in nextUp"
                :key="q.id"
                :id="`question-${q.id}`"
                :question="q"
                mode="pending"
                :saving="saving[q.id]"
                :asking="chatQuestionId === q.id"
                :prefill="prefills[q.id]"
                :pick="picks[q.id]"
                @answer="(v, ex) => answer(q, v, ex)"
                @skip="skip(q)"
                @ask="askAbout(q)"
                @box-text="t => (boxTexts[q.id] = t)"
              />
            </div>
          </section>

          <!-- The rest, grouped by what they ask about, with their counts. -->
          <section v-if="groups.length" class="questions-page__section" aria-labelledby="q-rest">
            <h2 id="q-rest" class="questions-page__h">The rest, by subject</h2>
            <div class="questions-page__groups">
              <div v-for="g in groups" :key="g.key" class="questions-page__group">
                <button
                  type="button"
                  class="questions-page__group-head"
                  :aria-expanded="openGroups.includes(g.key)"
                  :aria-controls="`q-group-${g.key}`"
                  @click="toggleGroup(g.key)"
                >
                  <v-icon :icon="openGroups.includes(g.key) ? 'mdi-chevron-down' : 'mdi-chevron-right'" size="18" />
                  <span class="questions-page__group-title">{{ g.title }}</span>
                  <span class="questions-page__n">{{ countText(g.items.length) }}</span>
                </button>
                <div v-show="openGroups.includes(g.key)" :id="`q-group-${g.key}`" class="questions-page__group-body">
                  <div class="questions-page__cards">
                    <KnowledgeQuestionCard
                      v-for="q in (openGroups.includes(g.key) ? shown(g.key, g.items) : [])"
                      :key="q.id"
                      :id="`question-${q.id}`"
                      :question="q"
                      mode="pending"
                      :saving="saving[q.id]"
                      :asking="chatQuestionId === q.id"
                      :prefill="prefills[q.id]"
                      :pick="picks[q.id]"
                      @answer="(v, ex) => answer(q, v, ex)"
                      @skip="skip(q)"
                      @ask="askAbout(q)"
                      @box-text="t => (boxTexts[q.id] = t)"
                    />
                  </div>
                  <v-btn v-if="g.items.length > shown(g.key, g.items).length" variant="outlined" class="questions-page__more" @click="showMore(g.key)">
                    Show {{ Math.min(PAGE, g.items.length - shown(g.key, g.items).length) }} more of {{ countText(g.items.length - shown(g.key, g.items).length) }}
                  </v-btn>
                </div>
              </div>
            </div>
          </section>
        </template>

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
            Answered <span class="questions-page__n">{{ countText(answered.length) }}</span>
          </v-btn>
          <div v-if="missingExample.length" class="questions-page__missing">
            <v-icon icon="mdi-text-box-plus-outline" size="18" class="questions-page__missing-icon" />
            <span class="text-body-2">
              {{ missingExample.length === 1 ? '1 yes answer has no example yet' : `${countText(missingExample.length)} yes answers have no example yet` }}
            </span>
            <v-btn
              variant="text"
              class="questions-page__missing-btn"
              :aria-pressed="onlyMissing"
              @click="toggleOnlyMissing"
            >
              {{ onlyMissing ? 'Show all answers' : 'Show only these' }}
            </v-btn>
          </div>
          <v-expand-transition>
            <!-- v-show sits on a plain wrapper: .d-flex is display: flex !important and would beat it. -->
            <div v-show="showAnswered" id="questions-answered">
              <div class="d-flex flex-column ga-3">
                <KnowledgeQuestionCard
                  v-for="q in (showAnswered ? shown('answered', answeredShown) : [])"
                  :key="q.id"
                  :id="`question-${q.id}`"
                  :question="q"
                  mode="answered"
                  :saving="saving[q.id]"
                  :asking="chatQuestionId === q.id"
                  :prefill="prefills[q.id]"
                  :pick="picks[q.id]"
                  @answer="(v, ex) => answer(q, v, ex)"
                  @example="t => saveExample(q, t)"
                  @ask="askAbout(q)"
                  @reopen="reopen(q)"
                  @box-text="t => (boxTexts[q.id] = t)"
                />
              </div>
              <v-btn v-if="answeredShown.length > shown('answered', answeredShown).length" variant="outlined" class="questions-page__more" @click="showMore('answered')">
                Show {{ Math.min(PAGE, answeredShown.length - shown('answered', answeredShown).length) }} more of {{ countText(answeredShown.length - shown('answered', answeredShown).length) }}
              </v-btn>
            </div>
          </v-expand-transition>
        </section>

        <!-- Skipped by you -->
        <section v-if="skipped.length" class="mb-4">
          <v-btn
            variant="text"
            class="px-1 mb-2 text-medium-emphasis questions-page__toggle"
            :prepend-icon="showSkipped ? 'mdi-chevron-down' : 'mdi-chevron-right'"
            :aria-expanded="showSkipped"
            aria-controls="questions-skipped"
            @click="showSkipped = !showSkipped"
          >
            Skipped by you <span class="questions-page__n">{{ countText(skipped.length) }}</span>
          </v-btn>
          <v-expand-transition>
            <!-- v-show sits on a plain wrapper: .d-flex is display: flex !important and would beat it. -->
            <div v-show="showSkipped" id="questions-skipped">
              <div class="d-flex flex-column ga-3">
                <KnowledgeQuestionCard
                  v-for="q in (showSkipped ? shown('skipped', skipped) : [])"
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
              <v-btn v-if="skipped.length > shown('skipped', skipped).length" variant="outlined" class="questions-page__more" @click="showMore('skipped')">
                Show {{ Math.min(PAGE, skipped.length - shown('skipped', skipped).length) }} more of {{ countText(skipped.length - shown('skipped', skipped).length) }}
              </v-btn>
            </div>
          </v-expand-transition>
        </section>

        <!-- Skipped by the app -->
        <section v-if="appSkipped.length" class="mb-4">
          <v-btn
            variant="text"
            class="px-1 mb-2 text-medium-emphasis questions-page__toggle"
            :prepend-icon="showAppSkipped ? 'mdi-chevron-down' : 'mdi-chevron-right'"
            :aria-expanded="showAppSkipped"
            aria-controls="questions-app-skipped"
            @click="showAppSkipped = !showAppSkipped"
          >
            Skipped by the app <span class="questions-page__n">{{ countText(appSkipped.length) }}</span>
          </v-btn>
          <v-expand-transition>
            <div v-show="showAppSkipped" id="questions-app-skipped">
              <p class="text-body-2 text-medium-emphasis mb-3 questions-page__app-skip-hint">
                The app skipped these, not you. Each says why. Reopen one to answer it anyway.
              </p>
              <div class="d-flex flex-column ga-3">
                <KnowledgeQuestionCard
                  v-for="q in (showAppSkipped ? shown('appSkipped', appSkipped) : [])"
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
              <v-btn v-if="appSkipped.length > shown('appSkipped', appSkipped).length" variant="outlined" class="questions-page__more" @click="showMore('appSkipped')">
                Show {{ Math.min(PAGE, appSkipped.length - shown('appSkipped', appSkipped).length) }} more of {{ countText(appSkipped.length - shown('appSkipped', appSkipped).length) }}
              </v-btn>
            </div>
          </v-expand-transition>
        </section>
      </template>
    </div>

    <!-- Wide screens: the chat beside the list -->
    <aside class="questions-page__chat" :class="{ 'questions-page__chat--compact': !chatInUse }">
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

    // Nothing asked yet: the rail is as tall as its prompt and its box, not a 650px empty column.
    &--compact {
      @media (min-width: 1280px) {
        height: auto;
      }
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

  &__blocking {
    color: rgb(var(--v-theme-warning));
  }

  &__promise {
    margin: -8px 0 16px;
    font-size: 0.8125rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__find {
    max-width: 420px;
    margin-bottom: 24px;
  }

  &__section {
    margin-bottom: 32px;
  }

  &__h {
    margin: 0 0 12px;
    font-size: 1rem;
    font-weight: 600;
  }

  // A count beside its label, in the secondary gray.
  &__n {
    margin-left: 6px;
    font-weight: 400;
    font-variant-numeric: tabular-nums;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__cards {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  &__empty {
    font-size: 0.875rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__more {
    margin-top: 12px;
  }

  &__groups {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  // A group row: a 44px button with its count; open, its cards follow ten at a time.
  &__group-head {
    width: 100%;
    min-height: 44px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px;
    border-radius: 10px;
    background: rgb(var(--v-theme-surface));
    color: inherit;
    text-align: left;
    font-size: 0.875rem;

    &:hover {
      background: rgb(var(--v-theme-surface-bright));
    }
  }

  &__group-title {
    font-weight: 500;
  }

  &__group-body {
    padding: 12px 0 16px;
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

  // "N yes answers have no example yet", under the Answered toggle.
  &__missing {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px 8px;
    margin: -4px 0 12px 4px;
  }

  &__missing-icon {
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__missing-btn {
    min-height: 44px;
    text-transform: none;
    letter-spacing: normal;
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

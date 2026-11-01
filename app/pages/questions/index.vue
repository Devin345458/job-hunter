<script setup lang="ts">
import type { AnswerOutcome, QuestionListItem } from '#shared/types/learning'

definePageMeta({ layout: 'default' })

const snackbar = useSnackbar()

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
    const parts = [`Saved to your knowledge base as ${where(`${out.knowledge!.category}:${out.knowledge!.key}`)}.`]
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

onMounted(load)
</script>

<template>
  <div class="fade-in questions-page">
    <div class="d-flex flex-wrap align-start justify-space-between ga-4 mb-8">
      <div class="page-header mb-0">
        <h1 class="text-h4 page-header__title">Questions</h1>
        <p class="text-body-2 page-header__subtitle">
          What the pipeline needs to know about you. Every answer goes into your knowledge base, a No included,
          so nothing is ever claimed on an application that you have not confirmed.
        </p>
      </div>
      <v-chip v-if="pending.length" variant="tonal" color="warning" class="questions-page__count">
        {{ pending.length }} to answer
      </v-chip>
    </div>

    <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-6" />

    <v-alert v-if="loadError" type="error" variant="tonal" class="mb-6">
      {{ loadError }}
      <template #append>
        <v-btn variant="text" size="small" @click="load">Try again</v-btn>
      </template>
    </v-alert>

    <template v-if="!loading && !loadError">
      <!-- Applications are waiting -->
      <section v-if="waitingOnYou.length" class="mb-8">
        <div class="section-label">Waiting on you</div>
        <div class="d-flex flex-column ga-3">
          <KnowledgeQuestionCard
            v-for="q in waitingOnYou"
            :key="q.id"
            :question="q"
            mode="pending"
            :saving="saving[q.id]"
            @answer="v => answer(q, v)"
            @skip="skip(q)"
          />
        </div>
      </section>

      <!-- One-tap and short answers -->
      <section v-if="quick.length" class="mb-8">
        <div class="section-label">Quick answers</div>
        <div class="d-flex flex-column ga-3">
          <KnowledgeQuestionCard
            v-for="q in quick"
            :key="q.id"
            :question="q"
            mode="pending"
            :saving="saving[q.id]"
            @answer="v => answer(q, v)"
            @skip="skip(q)"
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
            :question="q"
            mode="pending"
            :saving="saving[q.id]"
            @answer="v => answer(q, v)"
            @skip="skip(q)"
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
          class="px-1 mb-2 text-medium-emphasis"
          :prepend-icon="showAnswered ? 'mdi-chevron-down' : 'mdi-chevron-right'"
          :aria-expanded="showAnswered"
          @click="showAnswered = !showAnswered"
        >
          Answered ({{ answered.length }})
        </v-btn>
        <v-expand-transition>
          <div v-show="showAnswered" class="d-flex flex-column ga-3">
            <KnowledgeQuestionCard
              v-for="q in answered"
              :key="q.id"
              :question="q"
              mode="answered"
              :saving="saving[q.id]"
              @answer="v => answer(q, v)"
            />
          </div>
        </v-expand-transition>
      </section>

      <!-- Skipped -->
      <section v-if="skipped.length" class="mb-4">
        <v-btn
          variant="text"
          class="px-1 mb-2 text-medium-emphasis"
          :prepend-icon="showSkipped ? 'mdi-chevron-down' : 'mdi-chevron-right'"
          :aria-expanded="showSkipped"
          @click="showSkipped = !showSkipped"
        >
          Skipped ({{ skipped.length }})
        </v-btn>
        <v-expand-transition>
          <div v-show="showSkipped" class="d-flex flex-column ga-3">
            <KnowledgeQuestionCard
              v-for="q in skipped"
              :key="q.id"
              :question="q"
              mode="skipped"
              @reopen="reopen(q)"
            />
          </div>
        </v-expand-transition>
      </section>
    </template>
  </div>
</template>

<style scoped lang="scss">
.questions-page {
  max-width: 880px;

  &__note {
    max-width: 600px;
  }

  &__count {
    font-variant-numeric: tabular-nums;
  }
}
</style>

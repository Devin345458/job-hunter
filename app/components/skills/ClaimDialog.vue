<script setup lang="ts">
import { useDisplay } from 'vuetify'
import type { JobRescoreResult, QuestionView, SkillClaimAnswer, SkillClaimPreview, SkillClaimResult, SkillClaimSource } from '#shared/types/pipeline'
import { EXAMPLE_LEVELS, EXAMPLE_MAX_CHARS, type ChatQuestion } from '~/components/questions/chat-store'

// Tap a Missing skill or a requirement that is not Have, and say whether you have it.
// The panel shows what the knowledge base says today, asks the same Yes, Some experience, or No
// question as /questions (with "Where did you do it?" after a Yes), and saves through the question
// path (POST /api/jobs/:id/claim). Then Claude scores the job's skills again and the panel shows
// the new score. It never suggests an answer: the chat explains, and drafts only from what Devin types.
const props = defineProps<{
  modelValue: boolean
  jobId: number
  applicationId?: number | null
  /** The tapped chip or requirement row. */
  target: { text: string; source: SkillClaimSource } | null
  job?: { title: string; company: string } | null
  /** A "Prepare again" for this application is in flight. */
  preparing?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [open: boolean]
  /** The answer was saved, or the score changed: the page re-reads the job or the card. */
  'changed': []
  /** Prepare again for this application. */
  'prepare': [applicationId: number]
}>()

const { xs } = useDisplay()
const open = computed({
  get: () => props.modelValue,
  set: v => emit('update:modelValue', v),
})

const ANSWERS: SkillClaimAnswer[] = ['Yes', 'Some experience', 'No']
const ICONS: Record<SkillClaimAnswer, string> = { 'Yes': 'mdi-check', 'Some experience': 'mdi-circle-half-full', 'No': 'mdi-close' }

type View = 'loading' | 'error' | 'ask' | 'chat' | 'saved'
const view = ref<View>('loading')
const preview = ref<SkillClaimPreview | null>(null)
const loadError = ref<string | null>(null)

/** Yes or Some experience picked, waiting on the example box. */
const level = ref<SkillClaimAnswer | null>(null)
const exampleOpen = ref(false)
const exampleText = ref('')
const saving = ref<'save' | 'without' | 'no' | null>(null)
const saveError = ref<string | null>(null)
const result = ref<SkillClaimResult | null>(null)
const savedAnswer = ref<SkillClaimAnswer | null>(null)

const rescore = ref<'idle' | 'running' | 'done' | 'failed'>('idle')
const rescoreResult = ref<JobRescoreResult | null>(null)
const rescoreError = ref<string | null>(null)

/** Each opening gets a number, so a late answer from an earlier one never lands on this one. */
let session = 0

function errorText(e: any, fallback: string): string {
  if (!e?.response && !e?.statusCode && !e?.data) return 'The server did not answer. Check the connection, then try again.'
  return e?.data?.statusMessage || e?.data?.message || e?.statusMessage || fallback
}

function reset() {
  preview.value = null
  loadError.value = null
  level.value = null
  exampleOpen.value = false
  exampleText.value = ''
  saving.value = null
  saveError.value = null
  result.value = null
  savedAnswer.value = null
  rescore.value = 'idle'
  rescoreResult.value = null
  rescoreError.value = null
  chatQuestion.value = null
  chatError.value = null
  prepareAsked.value = false
}

async function load() {
  const t = props.target
  if (!t) return
  const mine = ++session
  reset()
  view.value = 'loading'
  try {
    const res = await $fetch<SkillClaimPreview>(`/api/jobs/${props.jobId}/claim`, {
      query: { text: t.text, source: t.source, applicationId: props.applicationId ?? undefined },
    })
    if (mine !== session) return
    preview.value = res
    // An answered Yes or Some experience starts from its saved example, so changing the level keeps it.
    exampleText.value = res.question.example ?? ''
    view.value = 'ask'
  }
  catch (e: any) {
    if (mine !== session) return
    loadError.value = errorText(e, 'Could not load this skill')
    view.value = 'error'
  }
}

const isExampleLevel = (a: string | null | undefined): a is SkillClaimAnswer => !!a && (EXAMPLE_LEVELS as readonly string[]).includes(a)
const busy = computed(() => saving.value !== null)
const previousAnswer = computed(() => preview.value?.question.status === 'answered' ? preview.value.question.answer : null)

function tap(a: SkillClaimAnswer) {
  if (busy.value) return
  saveError.value = null
  if (isExampleLevel(a)) {
    level.value = a
    exampleOpen.value = true
    return
  }
  level.value = null
  exampleOpen.value = false
  save('No', undefined, 'no')
}

const trimmedExample = computed(() => exampleText.value.trim())
const canSaveExample = computed(() => !!level.value && !!trimmedExample.value && trimmedExample.value.length <= EXAMPLE_MAX_CHARS)

function saveExample() {
  if (!canSaveExample.value || busy.value || !level.value) return
  save(level.value, trimmedExample.value, 'save')
}

function saveWithoutExample() {
  if (!level.value || busy.value) return
  // Absent keeps an example saved earlier, as on /questions.
  save(level.value, undefined, 'without')
}

async function save(answer: SkillClaimAnswer, example: string | undefined, action: 'save' | 'without' | 'no') {
  const t = props.target
  if (!t) return
  const mine = session
  saving.value = action
  saveError.value = null
  try {
    const body: Record<string, unknown> = { text: t.text, source: t.source, applicationId: props.applicationId ?? null, answer }
    if (example !== undefined) body.example = example
    const res = await $fetch<SkillClaimResult>(`/api/jobs/${props.jobId}/claim`, { method: 'POST', body })
    if (mine !== session) return
    result.value = res
    savedAnswer.value = answer
    view.value = 'saved'
    if (res.written) {
      emit('changed')
      runRescore(mine)
    }
  }
  catch (e: any) {
    if (mine === session) saveError.value = errorText(e, 'Could not save the answer')
  }
  finally {
    if (mine === session) saving.value = null
  }
}

async function runRescore(mine: number) {
  rescore.value = 'running'
  rescoreError.value = null
  try {
    const res = await $fetch<JobRescoreResult>(`/api/jobs/${props.jobId}/rescore`, { method: 'POST' })
    emit('changed')
    if (mine !== session) return
    rescoreResult.value = res
    rescore.value = res.ok ? 'done' : 'failed'
    rescoreError.value = res.ok ? null : res.message
  }
  catch (e: any) {
    if (mine !== session) return
    rescore.value = 'failed'
    rescoreError.value = errorText(e, 'Could not score the job again')
  }
}

function retryRescore() {
  runRescore(session)
}

// ── After the score: where the skill went ──
function norm(s: string) {
  return s.toLowerCase().replace(/\s*\([^)]*\)/g, ' ').replace(/[^a-z0-9+#./]+/g, ' ').trim()
}

/** The first chip in the list that names this skill. */
function chipFor(list: string[]): string | null {
  const p = preview.value
  if (!p) return null
  const names = [norm(p.name), norm(p.question.subject)].filter(n => n.length >= 2)
  return list.find(x => names.some(n => norm(x).includes(n))) ?? null
}

const placement = computed(() => {
  const s = rescoreResult.value?.score?.skills
  if (!s) return null
  const matched = chipFor(s.matched)
  if (matched) return { where: 'matched' as const, chip: matched }
  const missing = chipFor(s.missing)
  if (missing) return { where: 'missing' as const, chip: missing }
  return { where: 'neither' as const, chip: null }
})

/** The resume and letter predate this answer: offer Prepare again, never run it on its own. */
const staleMaterials = computed(() => !!result.value?.written && !!preview.value?.materials?.written)

/** One tap: a second POST while the first preparation runs would start another one beside it. */
const prepareAsked = ref(false)
function prepare() {
  const m = preview.value?.materials
  if (!m?.canPrepare || prepareAsked.value) return
  prepareAsked.value = true
  emit('prepare', m.applicationId)
}

// ── Ask about this: the /questions chat, about this skill's question ──
const chatQuestion = ref<ChatQuestion | null>(null)
const chatLoading = ref(false)
const chatError = ref<string | null>(null)

function toChatQuestion(q: QuestionView): ChatQuestion {
  return {
    id: q.id,
    question: q.question,
    status: q.status,
    answer: q.answer,
    answerType: q.answerType,
    choices: q.choices,
    kind: q.kind,
    legacy: false,
    job: props.job ?? null,
  }
}

async function openChat() {
  const t = props.target
  if (!t || chatLoading.value) return
  const mine = session
  chatLoading.value = true
  chatError.value = null
  try {
    // The chat needs a question to be about: the existing one, or a new pending one on this subject.
    const q = await $fetch<QuestionView>(`/api/jobs/${props.jobId}/claim/question`, {
      method: 'POST',
      body: { text: t.text, source: t.source, applicationId: props.applicationId ?? null },
    })
    if (mine !== session) return
    if (preview.value && preview.value.question.id == null) preview.value = { ...preview.value, question: { ...preview.value.question, id: q.id, status: q.status } }
    chatQuestion.value = toChatQuestion(q)
    view.value = 'chat'
  }
  catch (e: any) {
    if (mine === session) chatError.value = errorText(e, 'Could not open the chat')
  }
  finally {
    chatLoading.value = false
  }
}

function backFromChat() {
  view.value = 'ask'
}

/** A suggestion tapped in the chat: Yes or Some experience opens the example box; No saves. */
function answerFromChat(value: string) {
  view.value = 'ask'
  if (isExampleLevel(value) || value === 'No') tap(value as SkillClaimAnswer)
}

/** "Use this draft": the example goes into the box, and on a pending question its level is picked too. */
function useDraft(text: string, draftLevel: string | null = null) {
  if (isExampleLevel(draftLevel)) level.value = draftLevel
  else if (!level.value && isExampleLevel(previousAnswer.value)) level.value = previousAnswer.value
  exampleText.value = text
  exampleOpen.value = true
  view.value = 'ask'
}

function close() {
  open.value = false
}

const eyebrow = computed(() => props.target?.source === 'requirement' ? 'Posting requirement' : 'Missing skill')

// Last in setup: load() resets refs declared above, so this runs only once they all exist.
watch(() => [props.modelValue, props.target?.text, props.target?.source] as const, ([isOpen]) => {
  if (isOpen) load()
}, { immediate: true })
</script>

<template>
  <v-dialog v-model="open" :fullscreen="xs" max-width="560" scrollable class="skill-claim" :aria-label="preview ? preview.name : 'Skill'">
    <QuestionsChatPanel
      v-if="view === 'chat'"
      variant="dialog"
      class="skill-claim__chat"
      :question="chatQuestion"
      :saving="saving === 'no' ? 'No' : null"
      :box-text="exampleText"
      @answer="answerFromChat"
      @use-draft="useDraft"
      @detach="chatQuestion = null"
      @close="backFromChat"
    />

    <v-card v-else class="sc">
      <header class="sc__head">
        <div class="sc__head-text">
          <div class="sc__eyebrow">{{ eyebrow }}</div>
          <h2 class="sc__title">{{ preview?.name ?? target?.text ?? 'Skill' }}</h2>
        </div>
        <v-btn icon="mdi-close" variant="text" width="44" height="44" aria-label="Close" @click="close" />
      </header>

      <v-card-text class="sc__body">
        <div v-if="view === 'loading'" class="sc__loading" role="status">
          <v-progress-circular indeterminate size="20" width="2" />
          Reading your knowledge base
        </div>

        <div v-else-if="view === 'error'" class="sc__error" role="alert">
          <p>{{ loadError }}</p>
          <v-btn variant="tonal" height="44" prepend-icon="mdi-refresh" @click="load">Try again</v-btn>
        </div>

        <template v-else-if="preview">
          <dl class="sc__facts">
            <template v-if="preview.requirement">
              <dt>The posting asks for</dt>
              <dd>{{ preview.requirement }}</dd>
            </template>
            <template v-if="preview.why">
              <dt>Why it shows as missing</dt>
              <dd>{{ preview.why }}</dd>
            </template>
          </dl>

          <!-- Before the answer: what is there now. After it: what it says now. -->
          <div v-if="view === 'ask'" class="sc__kb">
            <template v-if="preview.knowledge">
              <div class="sc__kb-label">Your knowledge base says</div>
              <p class="sc__kb-text">{{ preview.knowledge.value }}</p>
            </template>
            <p v-else class="sc__kb-none">Your knowledge base has no entry on this yet.</p>
          </div>

          <div v-if="preview.isSandbox" class="sc__sandbox" role="note">
            <v-icon icon="mdi-flask-outline" size="18" />
            <span>This is a sandbox card. Nothing you answer here is written to your knowledge base, and no question is created.</span>
          </div>

          <!-- The question -->
          <section v-if="view === 'ask'" class="sc__ask" aria-labelledby="sc-question">
            <h3 id="sc-question" class="sc__question">{{ preview.question.text }}</h3>
            <p v-if="previousAnswer && !preview.isSandbox" class="sc__previous">You answered {{ previousAnswer }} before. A new answer replaces it.</p>
            <div class="sc__choices">
              <v-btn
                v-for="a in ANSWERS"
                :key="a"
                :variant="level === a ? 'outlined' : 'tonal'"
                :color="level === a ? 'primary' : undefined"
                :aria-pressed="level === a"
                :loading="a === 'No' && saving === 'no'"
                :disabled="busy"
                min-width="96"
                height="44"
                :prepend-icon="ICONS[a]"
                class="sc__choice"
                @click="tap(a)"
              >
                {{ a }}
              </v-btn>
              <v-btn
                v-if="!preview.isSandbox"
                variant="text"
                height="44"
                prepend-icon="mdi-chat-question-outline"
                class="sc__chat-btn"
                :loading="chatLoading"
                :disabled="busy"
                @click="openChat"
              >
                Ask about this
              </v-btn>
            </div>
            <p v-if="chatError" class="sc__save-error" role="alert">{{ chatError }}</p>

            <!-- After Yes or Some experience: where he did it, in his own words -->
            <div v-if="exampleOpen" class="sc__example" role="group" aria-labelledby="sc-example-label">
              <label id="sc-example-label" for="sc-example" class="sc__example-label">Where did you do it?</label>
              <p class="sc__example-hint">The job or project, what you did, and the result if there was one. It is saved exactly as you write it.</p>
              <v-textarea
                id="sc-example"
                v-model="exampleText"
                rows="3"
                auto-grow
                :maxlength="EXAMPLE_MAX_CHARS"
                :counter="EXAMPLE_MAX_CHARS"
                persistent-counter
                autocomplete="off"
                autofocus
                density="comfortable"
                :disabled="busy"
                class="sc__textarea"
              />
              <div class="sc__example-actions">
                <v-btn
                  :color="canSaveExample ? 'primary' : undefined"
                  :variant="canSaveExample ? 'flat' : 'tonal'"
                  height="44"
                  :loading="saving === 'save'"
                  :disabled="!canSaveExample || (busy && saving !== 'save')"
                  @click="saveExample"
                >
                  Save
                </v-btn>
                <v-btn
                  variant="text"
                  height="44"
                  :loading="saving === 'without'"
                  :disabled="!level || (busy && saving !== 'without')"
                  @click="saveWithoutExample"
                >
                  Save without an example
                </v-btn>
              </div>
            </div>
            <p v-if="saveError" class="sc__save-error" role="alert">{{ saveError }}</p>
          </section>

          <!-- After the answer -->
          <section v-else-if="view === 'saved' && result" class="sc__done" aria-live="polite">
            <template v-if="result.written">
              <p class="sc__done-title">
                <v-icon icon="mdi-check-circle-outline" color="success" size="20" />
                Saved: {{ savedAnswer }}
              </p>
              <div v-if="result.knowledge" class="sc__kb">
                <div class="sc__kb-label">Your knowledge base now says</div>
                <p class="sc__kb-text">{{ result.knowledge.value }}</p>
              </div>

              <div class="sc__rescore">
                <div v-if="rescore === 'running'" class="sc__loading" role="status">
                  <v-progress-circular indeterminate size="18" width="2" />
                  Re-scoring...
                </div>
                <template v-else-if="rescore === 'done' && rescoreResult">
                  <p v-if="rescoreResult.previousScore === rescoreResult.matchScore" class="sc__score">
                    <span>Match score <strong class="tabular">{{ rescoreResult.matchScore ?? 'none' }}</strong>, unchanged</span>
                    <span v-if="rescoreResult.score" class="sc__score-skills">(skills <span class="tabular">{{ rescoreResult.score.skills.score }}</span>)</span>
                  </p>
                  <p v-else class="sc__score">
                    Match score
                    <span class="tabular">{{ rescoreResult.previousScore ?? 'none' }}</span>
                    <v-icon icon="mdi-arrow-right" size="16" aria-label="to" />
                    <strong class="tabular">{{ rescoreResult.matchScore ?? 'none' }}</strong>
                    <span v-if="rescoreResult.score" class="sc__score-skills">(skills <span class="tabular">{{ rescoreResult.score.skills.score }}</span>)</span>
                  </p>
                  <p v-if="placement?.where === 'matched'" class="sc__placed sc__placed--good">Now under Matched: {{ placement.chip }}</p>
                  <p v-else-if="placement?.where === 'missing'" class="sc__placed">Still under Missing: {{ placement.chip }}</p>
                  <p v-else-if="placement" class="sc__placed">Not listed under Matched or Missing any more.</p>
                </template>
                <div v-else-if="rescore === 'failed'" class="sc__rescore-failed" role="alert">
                  <p>The answer is saved, but the score was not refreshed. {{ rescoreError }}</p>
                  <v-btn variant="tonal" height="44" prepend-icon="mdi-refresh" @click="retryRescore">Score again</v-btn>
                </div>
              </div>

              <div v-if="staleMaterials" class="sc__stale">
                <p>The resume and letter were written before this answer.</p>
                <p v-if="prepareAsked" class="sc__muted">Prepare again started.</p>
                <v-btn
                  v-else-if="preview.materials?.canPrepare"
                  variant="tonal"
                  color="primary"
                  height="44"
                  prepend-icon="mdi-restart"
                  :loading="preparing"
                  @click="prepare"
                >
                  Prepare again
                </v-btn>
              </div>
            </template>
            <template v-else>
              <p class="sc__done-title">
                <v-icon icon="mdi-flask-outline" size="20" />
                Nothing was written
              </p>
              <p class="sc__muted">Sandbox cards never change your knowledge base, so your {{ savedAnswer }} was not saved and the score stays as it is.</p>
            </template>
          </section>
        </template>
      </v-card-text>

      <div v-if="view === 'saved'" class="sc__foot">
        <v-btn color="primary" variant="flat" height="44" @click="close">Done</v-btn>
      </div>
    </v-card>
  </v-dialog>
</template>

<style lang="scss">
// The dialog content is teleported out of the page, so these rules cannot be scoped.
.v-dialog.skill-claim .question-chat.skill-claim__chat {
  height: min(720px, calc(100dvh - 48px));
}

.v-dialog.skill-claim.v-dialog--fullscreen .question-chat.skill-claim__chat {
  height: 100%;
  height: 100dvh;
}

.v-dialog.skill-claim .sc {
  display: flex;
  flex-direction: column;
  max-height: calc(100dvh - 48px);
}

.v-dialog.skill-claim.v-dialog--fullscreen .sc {
  max-height: none;
  height: 100dvh;
  border-radius: 0;
}

.sc {
  &__head {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 16px 12px 8px 20px;
    border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  }

  &__head-text {
    flex: 1;
    min-width: 0;
    padding-top: 4px;
  }

  &__eyebrow {
    font-size: 0.75rem;
    font-weight: 600;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__title {
    font-size: 1.125rem;
    font-weight: 650;
    line-height: 1.35;
    letter-spacing: -0.01em;
    margin: 2px 0 0;
    overflow-wrap: anywhere;
  }

  &__body {
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px 20px !important;
  }

  &__loading {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 0.875rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__error p {
    margin: 0 0 12px;
    color: rgb(var(--v-theme-error));
  }

  &__facts {
    display: grid;
    gap: 2px;
    margin: 0 0 14px;

    dt {
      font-size: 0.75rem;
      font-weight: 600;
      color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    }

    dd {
      margin: 0 0 8px;
      font-size: 0.875rem;
      overflow-wrap: anywhere;
    }
  }

  &__kb {
    margin-bottom: 16px;
    padding: 10px 12px;
    border-radius: 8px;
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    background: rgba(var(--v-theme-on-surface), 0.03);
  }

  &__kb-label {
    font-size: 0.75rem;
    font-weight: 600;
    margin-bottom: 2px;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__kb-text {
    margin: 0;
    font-size: 0.875rem;
    line-height: 1.5;
    white-space: pre-line;
    overflow-wrap: anywhere;
    max-height: 220px;
    overflow-y: auto;
  }

  &__kb-none {
    margin: 0;
    font-size: 0.875rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__sandbox {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    margin-bottom: 16px;
    padding: 10px 12px;
    border-radius: 8px;
    font-size: 0.875rem;
    border: 1px solid rgba(var(--v-theme-info), 0.4);
    background: rgba(var(--v-theme-info), 0.08);

    .v-icon {
      margin-top: 2px;
      flex-shrink: 0;
    }
  }

  &__question {
    font-size: 0.9375rem;
    font-weight: 600;
    line-height: 1.4;
    margin: 0 0 4px;
  }

  &__previous {
    font-size: 0.8125rem;
    margin: 0 0 10px;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__choices {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 10px;

    .v-btn {
      text-transform: none;
      letter-spacing: normal;
    }
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

  &__textarea {
    width: 100%;
  }

  &__example-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;

    .v-btn {
      text-transform: none;
      letter-spacing: normal;
    }
  }

  &__save-error {
    margin: 10px 0 0;
    font-size: 0.875rem;
    color: rgb(var(--v-theme-error));
  }

  &__done-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.9375rem;
    font-weight: 600;
    margin: 0 0 12px;
  }

  &__rescore {
    margin-bottom: 12px;
  }

  &__score {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin: 0 0 4px;
    font-size: 0.9375rem;
  }

  &__score-skills {
    font-size: 0.8125rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__placed {
    margin: 0;
    font-size: 0.875rem;
    overflow-wrap: anywhere;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));

    &--good {
      color: rgb(var(--v-theme-success));
    }
  }

  &__rescore-failed p {
    margin: 0 0 10px;
    font-size: 0.875rem;
    color: rgb(var(--v-theme-warning));
  }

  &__stale {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    padding-top: 12px;
    border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));

    p {
      margin: 0;
      font-size: 0.875rem;
    }

    .v-btn {
      text-transform: none;
      letter-spacing: normal;
    }
  }

  &__muted {
    margin: 0;
    font-size: 0.875rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__foot {
    display: flex;
    justify-content: flex-end;
    padding: 12px 20px 16px;
    border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  }
}
</style>

<script setup lang="ts">
import { PIPELINE_SCHEDULE_TEXT } from '#shared/utils/schedule'
import { REJECT_REASONS, type RejectReasonCode, type RejectSkillsMode, type ReviewItem } from '#shared/types/pipeline'
import { statusMeta } from '~/composables/review/format'

// The review queue. Opens on the best match, says how many are left, and moves to the next
// card after each decision. Stage 1 cards (To decide) take Apply or Reject; Apply prepares the
// application in the job queue and the card comes back under Ready to send for Approve or Reject. Desktop: queue list beside the open card. Phone: one card at a
// time with previous and next, and the full list in a sheet.
definePageMeta({ layout: 'default' })
useHead({ title: 'Review · Job Hunter' })

const route = useRoute()
const router = useRouter()
const snackbar = useSnackbar()
const health = usePipelineHealth()
const queue = useReviewQueue()
const { groups, ordered } = queue

const isDesktop = useState<boolean>('shell-is-desktop')

// ── Selection (kept in ?id= so a reload stays on the same card) ──
const selectedId = computed<number | null>(() => {
  const raw = Number(route.query.id)
  return Number.isInteger(raw) && raw > 0 ? raw : null
})
const selected = computed(() => queue.find(selectedId.value))

function select(id: number | null, opts: { scroll?: boolean } = {}) {
  router.replace({ query: { ...route.query, id: id ?? undefined } })
  sheetOpen.value = false
  if (opts.scroll !== false && import.meta.client) window.scrollTo({ top: 0 })
}

/** First card to show: the best match still waiting on a decision (stage 1, then stage 2), else whatever needs attention. */
function defaultId(): number | null {
  return groups.value.decide[0]?.applicationId ?? groups.value.send[0]?.applicationId ?? groups.value.attention[0]?.applicationId ?? groups.value.preparing[0]?.applicationId ?? null
}

/** Every card waiting on a decision, in queue order: stage 1, then stage 2. */
const deciding = computed(() => [...groups.value.decide, ...groups.value.send])

/** Where the open card sits in the whole queue, for previous and next. */
const orderedIndex = computed(() => ordered.value.findIndex(x => x.applicationId === selectedId.value))

const GROUP_POSITION: Record<'decide' | 'preparing' | 'send' | 'attention' | 'sending' | 'sent', string> = {
  decide: 'To decide:',
  preparing: 'Preparing:',
  send: 'Ready to send:',
  attention: 'Needs you:',
  sending: 'Sending:',
  sent: 'Submitted:',
}

/**
 * The open card's place within its own group, so the phone header agrees with the count beside
 * it: "10 left to decide" sits over "Card 1 of 10", not "Card 1 of 12" counting sent ones too.
 */
const position = computed(() => {
  for (const key of ['decide', 'preparing', 'send', 'attention', 'sending', 'sent'] as const) {
    const list = groups.value[key]
    const i = list.findIndex(x => x.applicationId === selectedId.value)
    if (i >= 0) return { label: GROUP_POSITION[key], count: `${i + 1} of ${list.length}` }
  }
  return null
})

function step(delta: number) {
  const list = ordered.value
  if (!list.length) return
  const i = orderedIndex.value
  const next = list[(i + delta + list.length) % list.length]
  if (next) select(next.applicationId)
}

/** The next card still waiting on a decision after the one just decided, by queue order. */
function nextDecideAfter(id: number, snapshot: ReviewItem[]): number | null {
  const i = snapshot.findIndex(x => x.applicationId === id)
  const rest = [...snapshot.slice(i + 1), ...snapshot.slice(0, Math.max(0, i))]
  const live = new Set(deciding.value.map(x => x.applicationId))
  return rest.find(x => live.has(x.applicationId) && x.applicationId !== id)?.applicationId ?? null
}

// ── Load ──
onMounted(async () => {
  await queue.load()
  if (!selected.value) select(defaultId(), { scroll: false })
})

// If the selected card disappears (rejected elsewhere, or a bad id), fall back.
watch(() => queue.loaded.value && !selected.value && ordered.value.length > 0, (lost) => {
  if (lost) select(defaultId(), { scroll: false })
})

queue.whenSettled((item) => {
  health.refresh()
  if (!item) return
  const name = `${item.job.title} at ${item.job.company}`
  const show = { text: 'Show', handler: () => select(item.applicationId) }
  if (item.status === 'submitted') snackbar.success(`Submitted: ${name}`, show)
  // The card and the queue keep showing the failure, so this notice can time out.
  else if (item.status === 'submit_failed') snackbar.notify(`Submit failed: ${name}`, 'error', { timeout: 10000, action: show })
  else if (item.status === 'needs_manual') snackbar.notify(`Submit by hand: ${name}`, 'warning', { timeout: 8000, action: show })
  else if (item.status === 'proposed') snackbar.notify(`Ready to send: ${name}`, 'info', { timeout: 6000, action: show })
  else if (item.status === 'needs_input') snackbar.notify(`Prepared, waiting on your answer: ${name}`, 'info', { timeout: 6000, action: show })
})

// ── Apply (stage 1): queue the preparation, then move on to the next card ──
const applyingId = ref<number | null>(null)

async function apply() {
  const item = selected.value
  if (!item || applyingId.value) return
  applyingId.value = item.applicationId
  const snapshot = [...deciding.value]
  try {
    await queue.apply(item.applicationId)
    health.refresh()
    const next = nextDecideAfter(item.applicationId, snapshot)
    snackbar.notify(
      `Preparing: ${item.job.title} at ${item.job.company}. It comes back under Ready to send.`,
      'success',
      { timeout: 6000, action: next ? { text: 'Show', handler: () => select(item.applicationId) } : undefined },
    )
    if (next) setTimeout(() => { if (selectedId.value === item.applicationId) select(next) }, 900)
  }
  catch (e: any) {
    snackbar.notify(e?.message || 'Apply failed', 'error', { timeout: -1 })
  }
  finally {
    applyingId.value = null
  }
}

// ── Decisions ──
const approvingId = ref<number | null>(null)

async function approve() {
  const item = selected.value
  if (!item || approvingId.value) return
  approvingId.value = item.applicationId
  const snapshot = [...deciding.value]
  const wasRetry = item.status === 'submit_failed'
  try {
    await queue.approve(item.applicationId)
    health.refresh()
    const next = wasRetry ? null : nextDecideAfter(item.applicationId, snapshot)
    // The phone notice sits under the app bar and keeps to two lines; the queue button shows Sending.
    snackbar.notify(
      `${wasRetry ? 'Retrying' : 'Approved'}: ${item.job.title} at ${item.job.company}.${isDesktop.value ? ' Following it under Sending.' : ''}`,
      'success',
      { timeout: 6000, action: next ? { text: 'Show', handler: () => select(item.applicationId) } : undefined },
    )
    // Leave the progress on screen for a beat, then move on to the next decision.
    if (next) setTimeout(() => { if (selectedId.value === item.applicationId) select(next) }, 900)
  }
  catch (e: any) {
    snackbar.notify(e?.message || 'Approve failed', 'error', { timeout: -1 })
  }
  finally {
    approvingId.value = null
  }
}

const rejectOpen = ref(false)
const rejecting = ref(false)
const rejectError = ref<string | null>(null)

function openReject() {
  rejectError.value = null
  rejectOpen.value = true
}

async function confirmReject(code: RejectReasonCode, text: string | null, skills: string[], skillsMode: RejectSkillsMode) {
  const item = selected.value
  if (!item) return
  rejecting.value = true
  rejectError.value = null
  const snapshot = [...deciding.value]
  const wasDecide = ['decide', 'send'].includes(statusMeta(item.status).group)
  try {
    await queue.reject(item.applicationId, code, text, skills, skillsMode)
    rejectOpen.value = false
    health.refresh()
    const reason = REJECT_REASONS.find(r => r.code === code)?.label ?? code
    const label = skills.length ? `${reason}: ${skills.join(', ')}` : reason
    snackbar.notify(`Rejected: ${item.job.title} (${label})`, 'info', { timeout: 5000 })
    select(wasDecide ? nextDecideAfter(item.applicationId, snapshot) ?? defaultId() : defaultId())
  }
  catch (e: any) {
    rejectError.value = e?.message || 'Reject failed'
  }
  finally {
    rejecting.value = false
  }
}

// ── Prepare again (a card whose preparation failed) ──
const preparingId = ref<number | null>(null)

async function prepareAgain() {
  const item = selected.value
  if (!item || preparingId.value) return
  preparingId.value = item.applicationId
  const snapshot = [...ordered.value]
  try {
    await $fetch(`/api/applications/${item.applicationId}/prepare`, { method: 'POST' })
    snackbar.notify(`Preparing again: ${item.job.title} at ${item.job.company}. It comes back to the queue when it is ready.`, 'info', { timeout: 8000 })
    // Preparing is not a queue state, so the card leaves the list; move on to the next one.
    const i = snapshot.findIndex(x => x.applicationId === item.applicationId)
    const next = [...snapshot.slice(i + 1), ...snapshot.slice(0, Math.max(0, i))].find(x => x.applicationId !== item.applicationId)
    await queue.fetchOne(item.applicationId)
    health.refresh()
    if (selectedId.value === item.applicationId) select(next?.applicationId ?? defaultId())
  }
  catch (e: any) {
    snackbar.notify(e?.data?.statusMessage || e?.message || 'Could not start preparing it again', 'error', { timeout: -1 })
  }
  finally {
    preparingId.value = null
  }
}

// ── Questions ──
/**
 * The question leaves every card that shows it as soon as it is sent (useReviewQueue), so there is
 * no spinner to hold; a failed save puts it back and says why.
 */
async function answer(questionId: number, value: string | null, skip = false) {
  const item = selected.value
  if (!item) return
  try {
    await queue.answerQuestion(item.applicationId, questionId, value, skip)
    health.refresh()
  }
  catch (e: any) {
    snackbar.notify(e?.message || 'Could not save the answer', 'error', { timeout: -1 })
  }
}

// ── Phone: the full list lives in a sheet ──
const sheetOpen = ref(false)

// ── Keyboard: J and K step through the queue. Approve never has a key. ──
function onKey(e: KeyboardEvent) {
  if (rejectOpen.value || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
  const t = e.target as HTMLElement | null
  if (t && (t.closest('input, textarea, select, [contenteditable="true"]'))) return
  // A dialog or menu is open (the skill panel, the screenshot): the keys belong to it. A notice
  // (snackbar) or tooltip is an overlay too, but it never takes the keys.
  if (document.querySelector('.v-dialog.v-overlay--active, .v-menu.v-overlay--active')) return
  const key = e.key.toLowerCase()
  if (key === 'j') step(1)
  else if (key === 'k') step(-1)
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

/** "3 to decide, 17 ready to send": only the numbers take tabular figures, so the comma keeps its own width. */
const leftParts = computed(() => [
  { n: groups.value.decide.length, text: 'to decide' },
  { n: groups.value.send.length, text: 'ready to send' },
].filter(p => p.n > 0))
</script>

<template>
  <div class="rv">
    <!-- Loading -->
    <div v-if="!queue.loaded.value && !queue.error.value" class="rv__loading" aria-busy="true" aria-label="Loading the review queue">
      <v-skeleton-loader type="heading, list-item-two-line@4" class="rv__skel-list" />
      <v-skeleton-loader type="heading, paragraph, image, paragraph" class="rv__skel-card" />
    </div>

    <!-- Error -->
    <div v-else-if="queue.error.value && !queue.items.value.length" class="rv__state" role="alert">
      <v-icon icon="mdi-cloud-alert-outline" size="28" color="error" />
      <h1 class="rv__state-title">The review queue did not load</h1>
      <p class="rv__state-text">{{ queue.error.value }}</p>
      <v-btn color="primary" height="44" prepend-icon="mdi-refresh" :loading="queue.loading.value" @click="queue.load()">Try again</v-btn>
    </div>

    <!-- Empty -->
    <div v-else-if="!ordered.length" class="rv__state">
      <v-icon icon="mdi-inbox-outline" size="28" />
      <h1 class="rv__state-title">Nothing to review</h1>
      <p class="rv__state-text">
        Jobs scoring 70 or more land here once a run has read their employer form. The pipeline runs {{ PIPELINE_SCHEDULE_TEXT }}, or start it from Settings.
      </p>
      <div class="rv__state-actions">
        <v-btn color="primary" height="44" to="/settings/pipeline" prepend-icon="mdi-play-outline">Pipeline settings</v-btn>
      </div>
      <ReviewHealth class="rv__state-health" />
    </div>

    <!-- Desktop: queue beside the card -->
    <div v-else-if="isDesktop" class="rv__panes">
      <aside class="rv__side">
        <header class="rv__side-head">
          <h1 class="rv__title">Review</h1>
          <p class="rv__left" :class="{ 'rv__left--done': !deciding.length }">
            <template v-if="!leftParts.length">All decided</template>
            <template v-else><template v-for="(p, i) in leftParts" :key="p.text"><span class="tabular">{{ p.n }}</span> {{ p.text }}{{ i < leftParts.length - 1 ? ', ' : '' }}</template></template>
          </p>
        </header>
        <ReviewHealth />
        <ReviewQueueList :groups="groups" :selected-id="selectedId" class="rv__list" @select="id => select(id)" />
        <p class="rv__keys">Keys: J next, K previous</p>
      </aside>
      <section class="rv__detail" aria-live="polite">
        <ReviewCard
          v-if="selected"
          :key="selected.applicationId"
          :item="selected"
          :approving="approvingId === selected.applicationId"
          :applying="applyingId === selected.applicationId"
          :refreshing="queue.refreshing.value.has(selected.applicationId)"
          :saving-question-id="null"
          :preparing="preparingId === selected.applicationId"
          fill
          @approve="approve"
          @apply="apply"
          @reject="openReject"
          @answer="(id, a) => answer(id, a)"
          @skip="id => answer(id, null, true)"
          @prepare="prepareAgain"
          @refresh="qid => selected && queue.answeredElsewhere(selected.applicationId, qid)"
        >
          <template #nav>
            <span v-if="position" class="rv__cardpos">{{ position.label }} <span class="tabular">{{ position.count }}</span></span>
            <v-btn variant="text" size="small" height="32" prepend-icon="mdi-chevron-left" aria-label="Previous card (K)" title="Previous card (K)" @click="step(-1)">Previous</v-btn>
            <v-btn variant="text" size="small" height="32" append-icon="mdi-chevron-right" aria-label="Next card (J)" title="Next card (J)" @click="step(1)">Next</v-btn>
          </template>
        </ReviewCard>
        <div v-else class="rv__state rv__state--pane">
          <v-icon icon="mdi-check-all" size="28" color="success" />
          <h2 class="rv__state-title">All decided</h2>
          <p class="rv__state-text">Pick anything on the left to see where it stands.</p>
        </div>
      </section>
    </div>

    <!-- Phone: one card at a time -->
    <div v-else class="rv__single">
      <div class="rv__mhead">
        <div>
          <p class="rv__left" :class="{ 'rv__left--done': !deciding.length }">
            <template v-if="!leftParts.length">All decided</template>
            <template v-else><template v-for="(p, i) in leftParts" :key="p.text"><span class="tabular">{{ p.n }}</span> {{ p.text }}{{ i < leftParts.length - 1 ? ', ' : '' }}</template></template>
          </p>
          <!-- Tabular figures give punctuation a digit-wide slot in Schibsted Grotesk ("Sending : 1"), so only the numbers use them. -->
          <p v-if="position" class="rv__pos">{{ position.label }} <span class="tabular">{{ position.count }}</span></p>
        </div>
        <div class="rv__nav">
          <v-btn icon="mdi-chevron-left" variant="tonal" width="44" height="44" aria-label="Previous card" @click="step(-1)" />
          <v-btn icon="mdi-chevron-right" variant="tonal" width="44" height="44" aria-label="Next card" @click="step(1)" />
          <v-btn variant="tonal" height="44" prepend-icon="mdi-format-list-bulleted" @click="sheetOpen = true">Queue</v-btn>
        </div>
      </div>
      <ReviewHealth variant="inline" class="rv__mhealth" />

      <ReviewCard
        v-if="selected"
        :key="selected.applicationId"
        :item="selected"
        :approving="approvingId === selected.applicationId"
        :applying="applyingId === selected.applicationId"
        :refreshing="queue.refreshing.value.has(selected.applicationId)"
        :saving-question-id="null"
        :preparing="preparingId === selected.applicationId"
        @approve="approve"
        @apply="apply"
        @reject="openReject"
        @answer="(id, a) => answer(id, a)"
        @skip="id => answer(id, null, true)"
        @prepare="prepareAgain"
        @refresh="qid => selected && queue.answeredElsewhere(selected.applicationId, qid)"
      />
      <div v-else class="rv__state rv__state--pane">
        <v-icon icon="mdi-check-all" size="28" color="success" />
        <h2 class="rv__state-title">All decided</h2>
        <p class="rv__state-text">Open the queue to see what is sending or sent.</p>
      </div>

      <v-bottom-sheet v-model="sheetOpen" scrollable>
        <v-card class="rv__sheet">
          <div class="rv__sheet-head">
            <span>Queue</span>
            <v-btn icon="mdi-close" variant="text" width="44" height="44" aria-label="Close the queue" @click="sheetOpen = false" />
          </div>
          <v-card-text class="rv__sheet-body">
            <ReviewQueueList :groups="groups" :selected-id="selectedId" @select="id => select(id)" />
          </v-card-text>
        </v-card>
      </v-bottom-sheet>
    </div>

    <ReviewRejectDialog
      v-if="selected"
      v-model="rejectOpen"
      :title="selected.job.title"
      :company="selected.job.company"
      :skill-options="selected.rejectSkillOptions"
      :is-sandbox="selected.isSandbox"
      :before-materials="selected.status === 'to_decide'"
      :busy="rejecting"
      :error="rejectError"
      @confirm="confirmReject"
    />
  </div>
</template>

<style scoped lang="scss">
.rv {
  &__panes {
    display: grid;
    grid-template-columns: 312px minmax(0, 1fr);
    gap: 20px;
    // The shell container pads 28px top and bottom on desktop.
    height: calc(100dvh - 56px);
  }

  &__side {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-height: 0;
    overflow-y: auto;
    padding-right: 4px;
  }

  &__side-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }

  &__title {
    font-size: 1.75rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: 1.1;
    margin: 0;
  }

  &__left {
    margin: 0;
    font-size: 0.875rem;
    font-weight: 600;
    color: rgb(var(--v-theme-primary));

    &--done {
      color: rgb(var(--v-theme-success));
    }
  }

  &__keys {
    margin: auto 0 0;
    padding: 8px;
    font-size: 0.75rem;
    color: rgba(var(--v-theme-on-surface), var(--v-disabled-opacity));
  }

  &__detail {
    min-height: 0;
    min-width: 0;
  }

  &__single {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  // Phone: the count and Previous, Next, Queue stay pinned under the app bar while the card
  // scrolls, so moving on never means scrolling back to the top. One 44px row plus padding.
  &__mhead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    position: sticky;
    top: var(--v-layout-top, 56px);
    z-index: 3;
    margin: -8px -16px 0;
    padding: 6px 16px;
    background: rgb(var(--v-theme-background));
    border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  }

  &__cardpos {
    margin-right: 4px;
    font-size: 0.75rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__pos {
    margin: 0;
    font-size: 0.75rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__nav {
    display: flex;
    gap: 6px;
  }

  &__state {
    max-width: 520px;
    margin: 48px auto;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;

    &--pane {
      margin: 0;
      max-width: none;
      height: 100%;
      justify-content: center;
      padding: 48px 16px;
      border-radius: 12px;
      border: 1px dashed rgba(var(--v-border-color), 0.25);
    }
  }

  &__state-title {
    font-size: 1.25rem;
    font-weight: 700;
    margin: 4px 0 0;
  }

  &__state-text {
    margin: 0;
    font-size: 0.875rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__state-actions {
    margin-top: 8px;
  }

  &__state-health {
    margin-top: 24px;
    width: 100%;
    text-align: left;
  }

  &__loading {
    display: grid;
    gap: 20px;

    @media (min-width: 960px) {
      grid-template-columns: 312px minmax(0, 1fr);
    }
  }

  &__skel-list,
  &__skel-card {
    background: transparent;
  }

  &__sheet {
    max-height: 80dvh;
  }

  &__sheet-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 4px 0 16px;
    font-weight: 700;
  }

  &__sheet-body {
    padding: 4px 8px 16px !important;
  }
}
</style>

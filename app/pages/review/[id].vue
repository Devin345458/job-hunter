<script setup lang="ts">
import { REJECT_REASONS, type RejectReasonCode, type ReviewItem } from '#shared/types/pipeline'

// One application on its own page, for links from Questions, Learning, or anywhere else.
// Same card, same actions as the queue; after a decision it offers the way back.
definePageMeta({ layout: 'default' })

const route = useRoute()
const snackbar = useSnackbar()
const health = usePipelineHealth()
const queue = useReviewQueue()

const id = computed(() => Number(route.params.id))
const item = computed(() => queue.find(id.value))
const state = ref<'loading' | 'ready' | 'missing' | 'error'>('loading')
const loadError = ref<string | null>(null)

useHead(() => ({ title: item.value ? `${item.value.job.company} · Review · Job Hunter` : 'Review · Job Hunter' }))

async function load() {
  state.value = 'loading'
  if (!Number.isInteger(id.value) || id.value <= 0) {
    state.value = 'missing'
    return
  }
  try {
    queue.upsert(await $fetch<ReviewItem>(`/api/review/${id.value}`))
    state.value = 'ready'
  }
  catch (e: any) {
    if (e?.statusCode === 404 || e?.response?.status === 404) state.value = 'missing'
    else {
      loadError.value = e?.data?.statusMessage || e?.message || 'Could not load this application'
      state.value = 'error'
    }
  }
}
onMounted(load)

queue.whenSettled((settled) => {
  health.refresh()
  if (!settled || settled.applicationId !== id.value) return
  if (settled.status === 'submitted') snackbar.success('Submitted')
  else if (settled.status === 'submit_failed') snackbar.notify('Submit failed. The error is on the card.', 'error', { timeout: 10000 })
  else if (settled.status === 'needs_manual') snackbar.notify('This one needs submitting by hand.', 'warning', { timeout: 8000 })
})

const approving = ref(false)
async function approve() {
  if (!item.value || approving.value) return
  approving.value = true
  try {
    await queue.approve(item.value.applicationId)
    health.refresh()
  }
  catch (e: any) {
    snackbar.notify(e?.message || 'Approve failed', 'error', { timeout: -1 })
  }
  finally {
    approving.value = false
  }
}

const rejectOpen = ref(false)
const rejecting = ref(false)
const rejectError = ref<string | null>(null)
const rejectedLabel = ref<string | null>(null)

async function confirmReject(code: RejectReasonCode, text: string | null) {
  if (!item.value) return
  rejecting.value = true
  rejectError.value = null
  try {
    await queue.reject(item.value.applicationId, code, text)
    rejectOpen.value = false
    rejectedLabel.value = REJECT_REASONS.find(r => r.code === code)?.label ?? code
    health.refresh()
  }
  catch (e: any) {
    rejectError.value = e?.message || 'Reject failed'
  }
  finally {
    rejecting.value = false
  }
}

const savingQuestionId = ref<number | null>(null)
async function answer(questionId: number, value: string | null, skip = false) {
  if (!item.value) return
  savingQuestionId.value = questionId
  try {
    const pending = queue.answerQuestion(item.value.applicationId, questionId, value, skip)
    await new Promise(r => setTimeout(r, 350))
    savingQuestionId.value = null
    await pending
    health.refresh()
  }
  catch (e: any) {
    snackbar.notify(e?.message || 'Could not save the answer', 'error', { timeout: -1 })
  }
  finally {
    savingQuestionId.value = null
  }
}
</script>

<template>
  <div class="rp">
    <div class="rp__top">
      <v-btn to="/" variant="text" height="44" prepend-icon="mdi-arrow-left" class="rp__back">Review queue</v-btn>
    </div>

    <v-skeleton-loader v-if="state === 'loading'" type="heading, paragraph, image, paragraph" class="rp__skel" />

    <div v-else-if="rejectedLabel" class="rp__state">
      <v-icon icon="mdi-close-circle-outline" size="28" />
      <h1 class="rp__state-title">Rejected</h1>
      <p class="rp__state-text">Reason: {{ rejectedLabel }}. Nothing was sent.</p>
      <v-btn color="primary" height="44" to="/">Back to the queue</v-btn>
    </div>

    <div v-else-if="state === 'missing'" class="rp__state">
      <v-icon icon="mdi-file-question-outline" size="28" />
      <h1 class="rp__state-title">No application with that number</h1>
      <p class="rp__state-text">It may have been removed. The queue has everything that is still open.</p>
      <v-btn color="primary" height="44" to="/">Open the queue</v-btn>
    </div>

    <div v-else-if="state === 'error'" class="rp__state" role="alert">
      <v-icon icon="mdi-cloud-alert-outline" size="28" color="error" />
      <h1 class="rp__state-title">This application did not load</h1>
      <p class="rp__state-text">{{ loadError }}</p>
      <v-btn color="primary" height="44" prepend-icon="mdi-refresh" @click="load">Try again</v-btn>
    </div>

    <template v-else-if="item">
      <ReviewCard
        :item="item"
        :approving="approving"
        :refreshing="queue.refreshing.value.has(item.applicationId)"
        :saving-question-id="savingQuestionId"
        @approve="approve"
        @reject="() => { rejectError = null; rejectOpen = true }"
        @answer="(qid, a) => answer(qid, a)"
        @skip="qid => answer(qid, null, true)"
      />
      <ReviewRejectDialog
        v-model="rejectOpen"
        :title="item.job.title"
        :company="item.job.company"
        :busy="rejecting"
        :error="rejectError"
        @confirm="confirmReject"
      />
    </template>
  </div>
</template>

<style scoped lang="scss">
.rp {
  max-width: 920px;
  margin: 0 auto;

  &__top {
    margin: -8px 0 8px -12px;
  }

  &__skel {
    background: transparent;
  }

  &__state {
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 48px 16px;
    border-radius: 12px;
    border: 1px dashed rgba(var(--v-border-color), 0.25);
  }

  &__state-title {
    font-size: 1.25rem;
    font-weight: 700;
    margin: 4px 0 0;
  }

  &__state-text {
    margin: 0 0 8px;
    font-size: 0.875rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }
}
</style>

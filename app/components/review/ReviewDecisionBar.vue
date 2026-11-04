<script setup lang="ts">
import type { ReviewItem } from '#shared/types/pipeline'
import { CAN_APPLY, CAN_APPROVE, CAN_REJECT, hostOf, plural } from '~/composables/review/format'

// The decision, pinned to the bottom of the card. Stage 1 (to_decide) offers Apply, which only
// queues the preparation; stage 2 offers Approve, one tap on a plain primary button (never a
// swipe). The line beside the buttons says exactly what the tap does, and to whom.
const props = defineProps<{
  item: ReviewItem
  approving: boolean
  /** An Apply request for this card is in flight. */
  applying?: boolean
  refreshing: boolean
  /** Where the card shows the questions approve waits on: "below the skills" on desktop, "above" on a phone. */
  questionsPlace?: string
}>()

const emit = defineEmits<{
  approve: []
  /** Stage 1: queue the preparation of this application. */
  apply: []
  reject: []
  /** Open the card's Demo project section and scroll to it. */
  showDemo: []
  /** Scroll the questions approve waits on into view and focus the first one. */
  showQuestions: []
}>()

const isDecide = computed(() => CAN_APPLY.includes(props.item.status))
/** At stage 1 nothing blocks Apply: the form's questions can be answered before or after it. */
const blocking = computed(() => (isDecide.value ? 0 : props.item.openQuestions.filter(q => q.blocking).length))
const demoBlocked = computed(() => props.item.approveEffect?.demoBlocked ?? null)
const canApprove = computed(() => CAN_APPROVE.includes(props.item.status) && blocking.value === 0 && !demoBlocked.value)
const canReject = computed(() => CAN_REJECT.includes(props.item.status))
const isRetry = computed(() => props.item.status === 'submit_failed')
const isManual = computed(() => props.item.status === 'needs_manual')
const prepareFailed = computed(() => isManual.value && /^prepare_failed/.test(props.item.form.error ?? ''))
// An approved application that came back as submit by hand (captcha, or real submits switched
// off) can try the automated submit again; the server reuses the original approve decision.
const canRetryManual = computed(() => isManual.value && !prepareFailed.value && props.item.submission?.method === 'manual')
const demoWillPublish = computed(() => props.item.demo?.status === 'built')
/**
 * Approve will publish the demo: say which one, and how its tests went, beside the button, with a
 * way to check it first. A demo that cannot publish (no GitHub token) says so instead of "to publish".
 */
const demoLine = computed(() => {
  const d = props.item.demo
  if (!d || !demoWillPublish.value || isRetry.value || !CAN_APPROVE.includes(props.item.status)) return null
  const tests = d.testsPassed === true ? 'tests passed' : d.testsPassed === false ? 'tests failed' : 'tests not run'
  const lead = demoBlocked.value ? 'Demo (cannot be published: the GitHub token is not set)' : 'Demo to publish'
  return { id: d.id, title: d.title, tests, failed: d.testsPassed === false, lead, blocked: !!demoBlocked.value }
})

const approveLabel = computed(() => (isRetry.value ? 'Retry submit' : props.item.approveEffect?.submit === 'manual' && !props.item.isSandbox ? 'Approve' : 'Approve and submit'))

/**
 * Every reason approve is off, one line each, said in the bar rather than a tooltip so it reads
 * on a phone. Open questions and a demo that cannot publish are separate problems; showing only
 * the first left the second hidden until the first was fixed.
 */
const blockedReasons = computed<string[]>(() => {
  const status = props.item.status
  const out: string[] = []
  if (blocking.value > 0) out.push(`Answer ${plural(blocking.value, 'question')} ${props.questionsPlace ?? 'above'} before you can approve.`)
  else if (status === 'needs_input') {
    out.push(props.refreshing ? 'Updating the form answers with what you said.' : 'Answers saved. Approve opens when the pipeline marks this ready.')
  }
  if (demoBlocked.value && (CAN_APPROVE.includes(status) || status === 'needs_input')) {
    out.push(`${demoBlocked.value.replace(/\.$/, '')}. Set it, or discard the demo, to approve.`)
  }
  return out
})

/**
 * The phone's one-line version of the consequence; the full sentence is one tap away under the
 * info button, so the decision bar leaves the card readable on a 390px screen.
 */
const shortConsequence = computed(() => {
  const effect = props.item.approveEffect
  const company = props.item.job.company || hostOf(props.item.job.applyUrl)
  const demo = demoWillPublish.value && !isRetry.value
  if (props.item.isSandbox || effect?.submit === 'sandbox') return demo ? 'Publishes the demo, then sends it to the sandbox form.' : 'Sends it to the sandbox test form.'
  if (effect?.submit === 'manual') return demo ? `Publishes the demo, then you submit on ${company}'s site.` : `Marks it for you to submit on ${company}'s site.`
  return demo ? `Publishes the demo, then sends it to ${company}.` : `Sends the application to ${company}.`
})
const detailsOpen = ref(false)
watch(() => props.item.applicationId, () => { detailsOpen.value = false })
/** Only the plain consequence line has a short form; blockers and by-hand notes always show in full. */
const hasShortForm = computed(() => !blockedReasons.value.length && !prepareFailed.value && !isManual.value && !isDecide.value)

/**
 * Stage 1, short: the safety promise, read at the moment Apply is pressed. A form the pipeline
 * cannot fill says so here too, since it changes what Apply leads to. The rest is one tap away.
 */
const applyShort = computed(() => {
  const formNote = props.item.form.error ? ' You would submit this form by hand.' : ''
  return `Nothing goes to ${props.item.job.company || 'the employer'} until you approve it.${formNote}`
})

/** Stage 1: what Apply does. A form the pipeline cannot fill says the application goes to Devin by hand. */
const applyLine = computed(() => {
  const formNote = props.item.form.error ? ' The form cannot be filled here, so you would submit it by hand.' : ''
  const questions = props.item.openQuestions.length
  const asks = questions ? ` The ${plural(questions, 'question')} on this card can be answered before or after.` : ''
  return `Apply writes the tailored resume, the cover letter, and the form answers, then fills the form without sending it. Nothing goes to ${props.item.job.company || 'the employer'} until you approve it.${formNote}${asks}`
})

const consequence = computed(() => {
  const effect = props.item.approveEffect
  const company = props.item.job.company || hostOf(props.item.job.applyUrl)
  const demo = demoWillPublish.value && !isRetry.value ? 'Publishes the demo repo, then ' : ''
  if (props.item.isSandbox || effect?.submit === 'sandbox') return `${demo ? demo : ''}${demo ? 'sends' : 'Sends'} the application to the sandbox test form under your name.`
  if (effect?.submit === 'manual') {
    const why = effect.manualReason ? ` (${effect.manualReason})` : ''
    return `${demo}${demo ? 'marks' : 'Marks'} it approved for you to submit on ${company}'s site yourself${why}. The resume, cover letter, and answers stay here to copy.`
  }
  return `${demo}${demo ? 'sends' : 'Sends'} the application to ${company} under your name.`
})
</script>

<template>
  <div v-if="isDecide || canApprove || canReject || isManual || item.status === 'needs_input'" class="bar" :class="{ 'bar--demo': demoLine }">
    <p v-if="demoLine" class="bar__demo">
      <v-icon icon="mdi-source-repository" size="15" class="bar__demo-icon" />
      <span class="bar__demo-text" :class="{ 'text-warning': demoLine.blocked }">{{ demoLine.lead }}: <strong>{{ demoLine.title }}</strong>, <span :class="{ 'text-error': demoLine.failed }">{{ demoLine.tests }}</span>.</span>
      <button type="button" class="bar__demo-link" @click="emit('showDemo')">Check it here</button>
      <NuxtLink :to="`/demos/${demoLine.id}`" class="bar__demo-link">Demo page</NuxtLink>
    </p>
    <div v-if="blockedReasons.length" class="bar__line bar__reasons" role="status">
      <p v-for="(r, i) in blockedReasons" :key="r" class="bar__reason">
        <v-icon icon="mdi-lock-outline" size="15" class="bar__reason-icon" />
        <!-- The questions line is a button: it scrolls the question into view and focuses it. -->
        <button v-if="i === 0 && blocking > 0" type="button" class="bar__reason-go" @click="emit('showQuestions')">{{ r }}</button>
        <span v-else>{{ r }}</span>
      </p>
    </div>
    <p v-else-if="isDecide" class="bar__line" role="status" :id="`bar-detail-${item.applicationId}`">
      {{ detailsOpen ? applyLine : applyShort }}
      <button
        type="button"
        class="bar__more"
        :aria-expanded="detailsOpen"
        :aria-controls="`bar-detail-${item.applicationId}`"
        @click="detailsOpen = !detailsOpen"
      >
        {{ detailsOpen ? 'Less' : 'What Apply does' }}
      </button>
    </p>
    <p v-else class="bar__line" :class="{ 'bar__line--long': hasShortForm, 'bar__line--open': detailsOpen }" role="status" :id="`bar-detail-${item.applicationId}`">
      <template v-if="prepareFailed">Nothing to submit until preparation succeeds. Reject it if you no longer want this job.</template>
      <template v-else-if="isManual">
        <template v-if="item.submission?.manualReason">{{ item.submission.manualReason }}. </template>Submit it on the employer's site, or reject if you changed your mind.
      </template>
      <template v-else>{{ consequence }}</template>
    </p>
    <p v-if="hasShortForm" class="bar__line bar__line--short" :class="{ 'bar__line--open': detailsOpen }">{{ shortConsequence }}</p>
    <div class="bar__buttons">
      <v-btn
        v-if="hasShortForm"
        variant="text"
        width="44"
        height="48"
        class="bar__info"
        :icon="detailsOpen ? 'mdi-information' : 'mdi-information-outline'"
        :aria-expanded="detailsOpen"
        :aria-controls="`bar-detail-${item.applicationId}`"
        aria-label="What approve does, in full"
        @click="detailsOpen = !detailsOpen"
      />
      <v-btn
        v-if="canReject"
        variant="outlined"
        height="48"
        class="bar__reject"
        prepend-icon="mdi-close"
        :disabled="approving || applying"
        @click="emit('reject')"
      >
        {{ isManual ? 'Not applying' : 'Reject' }}
      </v-btn>
      <v-btn
        v-if="canRetryManual"
        variant="tonal"
        height="48"
        class="bar__approve"
        prepend-icon="mdi-refresh"
        :disabled="blocking > 0"
        :loading="approving"
        @click="emit('approve')"
      >
        Try automated submit again
      </v-btn>
      <v-btn
        v-if="isDecide"
        color="primary"
        variant="flat"
        height="48"
        class="bar__approve"
        prepend-icon="mdi-file-document-edit-outline"
        :loading="applying"
        @click="emit('apply')"
      >
        Apply
      </v-btn>
      <v-btn
        v-if="!isManual && !isDecide"
        :color="canApprove ? 'primary' : undefined"
        :variant="canApprove ? 'flat' : 'tonal'"
        height="48"
        class="bar__approve"
        :prepend-icon="isRetry ? 'mdi-refresh' : 'mdi-send-check-outline'"
        :disabled="!canApprove"
        :loading="approving"
        @click="emit('approve')"
      >
        {{ approveLabel }}
      </v-btn>
    </div>
  </div>
</template>

<style scoped lang="scss">
.bar {
  display: flex;
  align-items: center;
  gap: 12px 20px;
  padding: 12px 20px;
  border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgb(var(--v-theme-surface));

  // A demo that approve publishes: one line across the top of the bar.
  &--demo {
    flex-wrap: wrap;
  }

  &__demo {
    flex: 1 0 100%;
    display: flex;
    align-items: center;
    gap: 6px 10px;
    margin: 0 0 -4px;
    font-size: 0.8125rem;
    line-height: 1.45;
    min-width: 0;
  }

  &__demo-icon {
    flex-shrink: 0;
    color: rgb(var(--v-theme-primary));
  }

  // Wraps rather than cutting the demo's name: a demo that cannot publish has a longer lead.
  &__demo-text {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  &__demo-link {
    flex-shrink: 0;
    font-weight: 600;
    color: rgb(var(--v-theme-primary));
    text-decoration: none;
    cursor: pointer;

    &:hover {
      text-decoration: underline;
    }
  }

  &__line {
    flex: 1;
    min-width: 0;
    margin: 0;
    font-size: 0.8125rem;
    line-height: 1.45;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));

  }

  // A text action in ink inside the consequence line.
  &__more {
    margin-left: 4px;
    padding: 0;
    font: inherit;
    font-weight: 500;
    color: rgb(var(--v-theme-on-surface));
    text-decoration: underline;
    text-underline-offset: 2px;
    background: none;
    border: 0;
    cursor: pointer;

    @media (max-width: 959.98px) {
      padding-block: 13px;
    }
  }

  &__reasons {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  &__reason {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    margin: 0;
    color: rgb(var(--v-theme-warning));
  }

  &__reason-icon {
    flex-shrink: 0;
    margin-top: 1px;
  }

  &__reason-go {
    font: inherit;
    color: inherit;
    text-align: left;
    background: none;
    border: 0;
    padding: 0;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;

    &:focus-visible {
      outline: 2px solid rgb(var(--v-theme-warning));
      outline-offset: 2px;
      border-radius: 2px;
    }
  }

  &__buttons {
    display: flex;
    gap: 10px;
    flex-shrink: 0;
  }

  &__approve {
    min-width: 188px;
  }

  &__reject {
    min-width: 112px;
  }

  // Desktop shows the full sentence; the short line and its info button are for the phone.
  &__line--short,
  &__info {
    display: none !important;
  }
}

@media (max-width: 599.98px) {
  .bar {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
    padding: 10px 16px 12px;

    &__line {
      font-size: 0.75rem;
    }

    // The phone's one-line consequence already says the demo publishes; the card above has the demo.
    &__demo {
      display: none;
    }

    &__buttons > * {
      flex: 1;
    }

    &__reject {
      flex: 0 0 auto !important;
      min-width: 112px;
    }

    &__approve {
      min-width: 0;
    }

    // One line on the phone; the info button swaps in the full sentence.
    &__line--long:not(.bar__line--open) {
      display: none;
    }

    &__line--short {
      display: block !important;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;

      &.bar__line--open {
        display: none !important;
      }
    }

    &__info {
      display: inline-flex !important;
      flex: 0 0 44px !important;
      min-width: 44px;
    }
  }
}
</style>

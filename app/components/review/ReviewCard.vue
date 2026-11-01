<script setup lang="ts">
import type { ReviewItem } from '#shared/types/pipeline'
import { answerText, hostOf, moneyRange, statusMeta, timeAgo } from '~/composables/review/format'

// One application, everything needed to decide on it. Order: what blocks the decision, the
// verdict (score and pay against the floor), then supporting detail, with long documents
// closed until opened. The decision bar stays pinned to the bottom.
const props = defineProps<{
  item: ReviewItem
  approving: boolean
  refreshing: boolean
  savingQuestionId: number | null
  /** Fill the parent's height and scroll inside (desktop two-pane). Otherwise the page scrolls and the bar sticks to the viewport bottom. */
  fill?: boolean
}>()

const emit = defineEmits<{
  approve: []
  reject: []
  answer: [questionId: number, answer: string]
  skip: [questionId: number]
}>()

const meta = computed(() => statusMeta(props.item.status))
const isDecide = computed(() => meta.value.group === 'decide')
const blockingQs = computed(() => props.item.openQuestions.filter(q => q.blocking))
const optionalQs = computed(() => props.item.openQuestions.filter(q => !q.blocking))
const isManual = computed(() => props.item.status === 'needs_manual')

const remote = computed(() => {
  const r = props.item.job.remoteType
  return r ? r.charAt(0).toUpperCase() + r.slice(1) : null
})

const skillsSummary = computed(() => {
  const s = props.item.score?.skills
  if (!s) return 'Not scored yet'
  const missing = s.missing.length ? `missing ${s.missing.slice(0, 2).join(', ')}${s.missing.length > 2 ? ` and ${s.missing.length - 2} more` : ''}` : 'nothing missing'
  return `${s.matched.length} matched, ${missing}`
})

const paySummary = computed(() => {
  const c = props.item.compensation
  if (!c) return props.item.job.salaryMin || props.item.job.salaryMax ? `Listing says ${moneyRange(props.item.job.salaryMin, props.item.job.salaryMax, props.item.job.salaryCurrency || 'USD')}` : 'Not extracted yet'
  const parts: string[] = []
  if (c.baseAnnualMin !== null || c.baseAnnualMax !== null) parts.push(`base ${moneyRange(c.baseAnnualMin, c.baseAnnualMax, c.currency)}`)
  else parts.push('no salary stated')
  if (c.bonus) parts.push('bonus')
  if (c.equity) parts.push('equity')
  parts.push(`${c.benefits.length} benefit${c.benefits.length === 1 ? '' : 's'} quoted`)
  return parts.join(', ')
})

const demoSummary = computed(() => {
  const d = props.item.demo
  if (!d) return ''
  const tests = d.testsPassed === true ? 'tests passed' : d.testsPassed === false ? 'tests failed' : 'tests not run'
  return `${d.title}: ${d.status}, ${tests}`
})
const demoTone = computed(() => props.item.demo?.status === 'failed' || props.item.demo?.testsPassed === false ? 'error' : 'default')

const answers = computed(() => props.item.form.answers)
const formSummary = computed(() => {
  const a = answers.value
  if (!a.length) return props.item.form.error ? 'Form fill failed' : 'Form not filled yet'
  const waiting = a.filter(x => x.needsQuestionId && !answerText(x.value)).length
  const check = a.filter(x => x.confidence !== 'high' && answerText(x.value)).length
  const parts = [`${a.length} fields`]
  if (waiting) parts.push(`${waiting} waiting on you`)
  if (check) parts.push(`${check} to check`)
  return parts.join(', ')
})
const formTone = computed(() => (props.item.form.error ? 'error' : answers.value.some(x => x.needsQuestionId && !answerText(x.value)) ? 'warning' : 'default'))

const resumeSummary = computed(() => {
  const r = props.item.resume
  if (!r) return 'Not written yet'
  return `${r.experience.length} roles, ${Object.values(r.skills).flat().length} skills`
})

const letterPreview = computed(() => {
  const text = props.item.coverLetter ?? ''
  const firstBody = text.split('\n').map(s => s.trim()).filter(Boolean)[1] ?? ''
  return text ? `${text.split(/\s+/).length} words. ${firstBody}` : 'Not written yet'
})
</script>

<template>
  <article class="rc" :class="{ 'rc--fill': fill }" :aria-label="`${item.job.title} at ${item.job.company}`">
    <div class="rc__body">
      <header class="rc__head">
        <div class="rc__eyebrow">
          <span class="rc__company">{{ item.job.company }}</span>
          <span class="rc__status" :class="`rc__status--${meta.color}`">
            <v-icon :icon="meta.icon" size="14" />
            {{ meta.label }}
          </span>
          <span v-if="item.isSandbox" class="rc__sandbox" title="Test data or the sandbox employer. Nothing reaches a real company.">Sandbox</span>
        </div>
        <h1 class="rc__title">{{ item.job.title }}</h1>
        <div class="rc__meta">
          <span v-if="item.job.location"><v-icon icon="mdi-map-marker-outline" size="14" /> {{ item.job.location }}</span>
          <span v-if="remote"><v-icon icon="mdi-home-city-outline" size="14" /> {{ remote }}</span>
          <span><v-icon icon="mdi-radar" size="14" /> {{ item.job.source }}</span>
          <span v-if="item.proposedAt"><v-icon icon="mdi-clock-outline" size="14" /> proposed {{ timeAgo(item.proposedAt) }}</span>
          <span v-if="item.job.atsType && item.job.atsType !== 'unknown'"><v-icon icon="mdi-form-select" size="14" /> {{ item.job.atsType }}</span>
        </div>
        <div class="rc__links">
          <v-btn
            v-if="item.job.url"
            :href="item.job.url"
            target="_blank"
            rel="noopener"
            variant="tonal"
            height="44"
            append-icon="mdi-open-in-new"
          >
            Posting
          </v-btn>
          <v-btn
            v-if="item.job.applyUrl && item.job.applyUrl !== item.job.url"
            :href="item.job.applyUrl"
            target="_blank"
            rel="noopener"
            variant="text"
            height="44"
            append-icon="mdi-open-in-new"
          >
            Form on {{ hostOf(item.job.applyUrl) }}
          </v-btn>
        </div>
      </header>

      <div v-if="!isDecide" class="rc__block">
        <ReviewProgress :item="item" />
      </div>

      <div v-if="blockingQs.length || (item.status === 'needs_input' && refreshing)" class="rc__block rc__block--first">
        <h2 class="rc__h">Answer first</h2>
        <ReviewQuestions
          :questions="blockingQs"
          :saving-id="savingQuestionId"
          :refreshing="refreshing"
          @answer="(id, a) => emit('answer', id, a)"
          @skip="id => emit('skip', id)"
        />
      </div>

      <div class="rc__verdict">
        <div class="rc__panel">
          <ReviewScoreLedger v-if="item.score" :score="item.score" />
          <p v-else class="rc__empty">Not scored yet.</p>
        </div>
        <div class="rc__panel">
          <ReviewCompFloor
            :comp="item.compensation"
            :score="item.score"
            :listing="{ min: item.job.salaryMin, max: item.job.salaryMax, currency: item.job.salaryCurrency }"
            compact
          />
        </div>
      </div>

      <div class="rc__sections">
        <ReviewSection title="Skills fit" icon="mdi-puzzle-outline" :summary="skillsSummary" default-open>
          <ReviewSkills :score="item.score" :requirements="item.requirements" />
        </ReviewSection>

        <ReviewSection title="Pay and benefits" icon="mdi-cash-multiple" :summary="paySummary">
          <ReviewCompFloor
            :comp="item.compensation"
            :score="item.score"
            :listing="{ min: item.job.salaryMin, max: item.job.salaryMax, currency: item.job.salaryCurrency }"
          />
        </ReviewSection>

        <ReviewSection v-if="item.demo" title="Demo project" icon="mdi-source-repository" :summary="demoSummary" :tone="demoTone">
          <ReviewDemo :demo="item.demo" />
          <p v-if="item.gap?.summary" class="rc__gap">Gap analysis: {{ item.gap.summary }}</p>
        </ReviewSection>

        <ReviewSection
          :key="`form-${isManual}`"
          title="Form answers"
          icon="mdi-form-textbox"
          :summary="formSummary"
          :tone="formTone"
          :default-open="isManual"
        >
          <ReviewFormAnswers
            :answers="answers"
            :snapshot="item.form.snapshot"
            :screenshot-url="item.form.screenshotUrl"
            :filled-at="item.form.filledAt"
            :form-error="item.form.error"
            :copy-mode="isManual"
          />
        </ReviewSection>

        <ReviewSection title="Resume" icon="mdi-file-account-outline" :summary="resumeSummary">
          <ReviewResume v-if="item.resume" :resume="item.resume" :pdf-url="item.resumePdfUrl" />
          <p v-else class="rc__empty">No tailored resume yet.</p>
        </ReviewSection>

        <ReviewSection title="Cover letter" icon="mdi-email-outline" :summary="letterPreview">
          <div v-if="item.coverLetter" class="rc__letter">{{ item.coverLetter }}</div>
          <p v-else class="rc__empty">No cover letter yet.</p>
        </ReviewSection>

        <ReviewSection
          v-if="optionalQs.length"
          title="Optional questions"
          icon="mdi-comment-question-outline"
          :summary="`${optionalQs.length} open, answering improves future matches`"
          default-open
        >
          <ReviewQuestions
            :questions="optionalQs"
            :saving-id="savingQuestionId"
            @answer="(id, a) => emit('answer', id, a)"
            @skip="id => emit('skip', id)"
          />
        </ReviewSection>

        <ReviewSection title="Full posting" icon="mdi-text-box-outline" :summary="item.job.descriptionText ? `${item.job.descriptionText.split(/\s+/).length} words` : 'No text saved'">
          <div v-if="item.job.descriptionText" class="rc__posting">{{ item.job.descriptionText }}</div>
        </ReviewSection>
      </div>
    </div>

    <ReviewDecisionBar
      class="rc__bar"
      :item="item"
      :approving="approving"
      :refreshing="refreshing"
      @approve="emit('approve')"
      @reject="emit('reject')"
    />
  </article>
</template>

<style scoped lang="scss">
.rc {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: rgb(var(--v-theme-surface));
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 12px;

  &__body {
    flex: 1;
    min-height: 0;
    padding: 20px 24px 8px;
  }

  &__eyebrow {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 10px;
    margin-bottom: 4px;
  }

  &__company {
    font-weight: 600;
    font-size: 0.9375rem;
    color: rgba(var(--v-theme-on-surface), 0.86);
  }

  &__status {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 0.75rem;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 6px;

    @each $c in primary, warning, error, success, secondary {
      &--#{$c} {
        color: rgb(var(--v-theme-#{$c}));
        background: rgba(var(--v-theme-#{$c}), 0.12);
      }
    }
  }

  &__sandbox {
    font-size: 0.75rem;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 6px;
    color: rgb(var(--v-theme-info));
    border: 1px dashed rgba(var(--v-theme-info), 0.6);
  }

  &__title {
    font-size: 1.375rem;
    font-weight: 700;
    line-height: 1.25;
    letter-spacing: -0.015em;
    margin: 0 0 8px;
    overflow-wrap: anywhere;
  }

  &__meta {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
    font-size: 0.8125rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));

    span {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
  }

  &__links {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 12px;
  }

  &__block {
    margin-top: 20px;
  }

  &__h {
    font-size: 0.8125rem;
    font-weight: 700;
    margin: 0 0 8px;
    color: rgb(var(--v-theme-warning));
  }

  &__verdict {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 12px;
    margin: 20px 0 8px;
  }

  &__panel {
    padding: 16px;
    border-radius: 8px;
    background: rgb(var(--v-theme-background));
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  }

  &__sections {
    margin-top: 12px;
  }

  &__gap {
    margin: 12px 0 0;
    font-size: 0.8125rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__letter,
  &__posting {
    white-space: pre-line;
    font-size: 0.875rem;
    line-height: 1.65;
    padding: 16px 18px;
    border-radius: 8px;
    background: rgb(var(--v-theme-sunken));
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    max-height: 480px;
    overflow-y: auto;
  }

  &__empty {
    margin: 0;
    font-size: 0.875rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__bar {
    border-radius: 0 0 12px 12px;
    position: sticky;
    bottom: var(--v-layout-bottom, 0px);
    z-index: 2;
  }

  &--fill {
    height: 100%;
  }

  &--fill &__body {
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  &--fill &__bar {
    position: static;
  }
}

@media (max-width: 599.98px) {
  .rc {
    border-radius: 10px;

    &__body {
      padding: 16px 16px 4px;
    }

    &__title {
      font-size: 1.25rem;
    }

    &__panel {
      padding: 14px;
    }

    &__verdict {
      grid-template-columns: minmax(0, 1fr);
    }

    &__bar {
      border-radius: 0 0 10px 10px;
    }
  }
}
</style>

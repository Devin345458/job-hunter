<script setup lang="ts">
import type { ReviewItem, SkillClaimSource } from '#shared/types/pipeline'
import { answerText, formQuestionIds, hostOf, itemStatusMeta, moneyRange, plural, properName, timeAgo } from '~/composables/review/format'
import { demoStopKind, fixPlurals, gapSummaryText, plainKnowledgeRefs } from '#shared/utils/plain-text'
import { questionsAbout, skillSets, softSkillsCount } from '#shared/utils/skill-sets'

// One application, everything needed to decide on it. Order: what blocks the decision, the
// verdict (score and pay against the floor), then supporting detail, with long documents
// closed until opened. Two stages: a Decide card (to_decide) has the score, pay, skills, the gap
// plan, and what the form read found, with Apply and Reject; nothing is written for it yet. A Send
// card (proposed, needs_input) adds the resume, letter, and filled form, with Approve and Reject. The decision bar stays pinned to the bottom. On desktop (fill) the
// verdict comes first, with every Missing skill under it, so a 1280x800 screen shows title,
// score, pay, Missing, Matched count, and the decision bar without scrolling; Answer first follows.
const props = defineProps<{
  item: ReviewItem
  approving: boolean
  /** An Apply request for this card is in flight (stage 1). */
  applying?: boolean
  refreshing: boolean
  savingQuestionId: number | null
  /** A "Prepare again" request for this card is in flight. */
  preparing?: boolean
  /** Fill the parent's height and scroll inside (desktop two-pane). Otherwise the page scrolls and the bar sticks to the viewport bottom. */
  fill?: boolean
  /** The job title's heading level: h1 when the card is the page (/review/:id), h2 under the queue's "Review". */
  titleTag?: 'h1' | 'h2'
}>()

const emit = defineEmits<{
  approve: []
  /** Stage 1: queue the preparation. */
  apply: []
  reject: []
  answer: [questionId: number, answer: string]
  skip: [questionId: number]
  prepare: []
  /** The skill panel saved an answer or the score changed: re-read this application, and every card showing the question it answered. */
  refresh: [questionId?: number | null]
}>()

// ── The skill panel: a Missing chip or a requirement that is not Have, tapped in Skills fit ──
const claimOpen = ref(false)
const claimTarget = ref<{ text: string; source: SkillClaimSource } | null>(null)
function openClaim(text: string, source: SkillClaimSource) {
  claimTarget.value = { text, source }
  claimOpen.value = true
}

const meta = computed(() => itemStatusMeta(props.item))
const company = computed(() => props.item.job.company || hostOf(props.item.job.applyUrl))
/** A card with a decision on it (stage 1 or stage 2); any other card shows its progress instead. */
const isDecisionCard = computed(() => meta.value.group === 'decide' || meta.value.group === 'send')
/** Stage 1: Apply or Reject, before any resume, letter, or form answer exists. */
const isStageOne = computed(() => props.item.status === 'to_decide')
const blockingQs = computed(() => (isStageOne.value ? [] : props.item.openQuestions.filter(q => q.blocking)))
const showAnswerFirst = computed(() => blockingQs.value.length > 0 || (props.item.status === 'needs_input' && props.refreshing))
const optionalQs = computed(() => (isStageOne.value ? [] : props.item.openQuestions.filter(q => !q.blocking)))
/** Stage 1: the questions the form read asked, required or not. None of them holds up Apply. */
const stageOneFormIds = computed(() => formQuestionIds(props.item))
const formQs = computed(() => (isStageOne.value ? props.item.openQuestions.filter(q => stageOneFormIds.value.has(q.id)) : []))
/** Stage 1: skills and experience the gap plan asks about. An answer can change the score and what the resume says. */
const skillQs = computed(() => (isStageOne.value ? props.item.openQuestions.filter(q => !stageOneFormIds.value.has(q.id)) : []))

const gapSummary = computed(() => {
  const g = props.item.gap
  if (!g) return 'Not made yet'
  return plainKnowledgeRefs(fixPlurals(gapSummaryText(g.summary, null)))
})
/** Stage 1 form summary: "14 fields, 6 filled from your profile, 2 waiting on you, 6 written when you apply". */
const formReadSummary = computed(() => {
  if (props.item.form.error) return 'Apply by hand'
  const snap = props.item.form.snapshot
  if (!snap) return 'Not read yet'
  const a = props.item.form.answers
  // The resume and cover letter uploads count as written at Apply, as the section lists them.
  const doc = (x: typeof a[number]) => x.source === 'resume' || x.source === 'cover_letter'
  const filled = a.filter(x => !!answerText(x.value) && !doc(x)).length
  const waiting = a.filter(x => typeof x.needsQuestionId === 'number' && !answerText(x.value)).length
  const later = a.filter(x => x.atApply || doc(x)).length
  const parts = [plural(snap.fields.length, 'field'), `${filled} from your profile`]
  if (waiting) parts.push(`${waiting} waiting on you`)
  if (later) parts.push(`${later} written when you apply`)
  return parts.join(', ')
})
const isManual = computed(() => props.item.status === 'needs_manual')
/** Preparation threw (Claude refused, a step crashed), so there is no resume or form to submit. */
const prepareFailed = computed(() => /^prepare_failed/.test(props.item.form.error ?? ''))

/** The info line, each fact once: "Remote US" already says remote, and an Ashby posting on an Ashby form is one fact. */
const facts = computed(() => {
  const j = props.item.job
  const out: Array<{ icon: string; text: string }> = []
  if (j.location) out.push({ icon: 'mdi-map-marker-outline', text: j.location })
  const r = j.remoteType
  if (r && !(j.location ?? '').toLowerCase().includes(r.toLowerCase())) out.push({ icon: 'mdi-home-city-outline', text: r.charAt(0).toUpperCase() + r.slice(1) })
  const ats = j.atsType && !['unknown', 'other'].includes(j.atsType) ? j.atsType : null
  if (ats && ats === j.source) out.push({ icon: 'mdi-radar', text: `${properName(j.source)} posting and form` })
  else {
    out.push({ icon: 'mdi-radar', text: j.source === 'manual' ? 'Added by hand' : `Found on ${properName(j.source)}` })
    if (ats) out.push({ icon: 'mdi-form-select', text: `${properName(ats)} form` })
  }
  return out
})

/** Where each question a form field waits on sits on this card. */
function questionHint(id: number) {
  const q = props.item.openQuestions.find(x => x.id === id)
  if (!q) return ''
  return q.blocking ? 'under Answer first, above' : 'under Optional questions, below'
}

/** Matched and Missing from the posting requirements, so the chips agree with the checklist (shared/utils/skill-sets.ts). */
const sets = computed(() => skillSets(props.item.requirements, props.item.score))
const hasSkills = computed(() => !!props.item.score || sets.value.matched.length > 0 || sets.value.missing.length > 0 || sets.value.soft.length > 0)

/**
 * Soft skills that are not matched, as one neutral line under the Missing chips: never red and
 * never in the Missing count. The open questions that ask about them, when there are any, are
 * one tap away under Optional questions (or Answer first).
 */
const softLine = computed(() => {
  const soft = sets.value.soft
  if (!soft.length) return null
  const asked = questionsAbout(soft, props.item.openQuestions)
  return { count: softSkillsCount(soft.length), names: soft.map(c => c.name).join('; '), asked: asked.length, blocking: asked.some(q => q.blocking) }
})
const optionalSection = ref<{ show: () => void } | null>(null)
function showSoftQuestions() {
  if (softLine.value?.blocking) showQuestions()
  else optionalSection.value?.show()
}

/** The block of questions approve waits on; the decision bar's lock line scrolls here. */
const answerFirst = ref<HTMLElement | null>(null)
const answerFirstAfter = ref<HTMLElement | null>(null)
/** Where Answer first sits, for the bar's wording: under the skills on desktop, above the score on a phone. */
const questionsPlace = computed(() => (props.fill ? 'below the skills' : 'above'))
function showQuestions() {
  const el = props.fill ? answerFirstAfter.value : answerFirst.value
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  // The first answer control, not the "Ask about this" chat button at the top of the question.
  const controls = [...el.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])')]
  const control = controls.find(c => !c.closest('.qs__ask, .qs__top')) ?? controls[0]
  control?.focus({ preventScroll: true })
}

const skillsSummary = computed(() => {
  if (!hasSkills.value) return 'Not scored yet'
  const names = sets.value.missing.map(c => c.label)
  const missing = names.length ? `missing ${names.slice(0, 2).join(', ')}${names.length > 2 ? ` and ${names.length - 2} more` : ''}` : 'nothing missing'
  return `${sets.value.matched.length} matched, ${missing}`
})

/**
 * The phone summary under the score: "Matched 11 · Missing: Python, Infrastructure as code and 3
 * more". Names are cut to fit two short lines; a parenthesized aside is dropped from a name.
 */
const MISSING_BUDGET = 44
const glance = computed(() => {
  if (!hasSkills.value) return null
  const names = sets.value.missing.map(c => c.label.replace(/\s*\([^)]*\)/g, '').trim()).filter(Boolean)
  const shown: string[] = []
  let used = 0
  for (const n of names) {
    if (shown.length && used + n.length > MISSING_BUDGET) break
    shown.push(n)
    used += n.length + 2
  }
  const rest = names.length - shown.length
  const missing = !names.length ? 'nothing' : rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.length === 2 ? shown.join(' and ') : shown.join(', ')
  return { matched: sets.value.matched.length, missing, none: !names.length }
})

const paySummary = computed(() => {
  const c = props.item.compensation
  if (!c) return props.item.job.salaryMin || props.item.job.salaryMax ? `Listing says ${moneyRange(props.item.job.salaryMin, props.item.job.salaryMax, props.item.job.salaryCurrency || 'USD')}` : 'Not extracted yet'
  const parts: string[] = []
  if (c.baseAnnualMin !== null || c.baseAnnualMax !== null) parts.push(`base ${moneyRange(c.baseAnnualMin, c.baseAnnualMax, c.currency)}`)
  else parts.push('no salary stated')
  if (c.bonus) parts.push('bonus')
  if (c.equity) parts.push('equity')
  parts.push(`${plural(c.benefits.length, 'benefit')} quoted`)
  return parts.join(', ')
})

/** A failed build that stopped on the Claude account (credit, key, budget) rather than on the build. */
const demoStopped = computed(() => props.item.demo?.status === 'failed' && !!demoStopKind(props.item.demo.error))
const demoSummary = computed(() => {
  const d = props.item.demo
  if (!d) return ''
  const tests = d.testsPassed === true ? 'tests passed' : d.testsPassed === false ? 'tests failed' : 'tests not run'
  return `${d.title}: ${demoStopped.value ? 'stopped' : d.status}, ${tests}`
})
const demoTone = computed(() => (props.item.demo?.status === 'failed' && !demoStopped.value) || props.item.demo?.testsPassed === false ? 'error' : 'default')
/** The gap summary, agreeing with the demo this card shows. */
const gapLine = computed(() => plainKnowledgeRefs(fixPlurals(gapSummaryText(props.item.gap?.summary, props.item.demo))))

const demoSection = ref<{ show: () => void } | null>(null)

const answers = computed(() => props.item.form.answers)
const fieldsById = computed(() => new Map((props.item.form.snapshot?.fields ?? []).map(f => [f.id, f])))
/** Empty fields that wait on a question: a required one holds up the application, an optional one does not. A field the snapshot does not list counts as required. */
const unfilled = computed(() => answers.value.filter(x => x.needsQuestionId && !answerText(x.value)))
const waitingRequired = computed(() => unfilled.value.filter(x => fieldsById.value.get(x.fieldId)?.required !== false).length)
const formSummary = computed(() => {
  const a = answers.value
  if (!a.length) return prepareFailed.value ? 'Not filled' : props.item.form.error ? 'Form fill failed' : 'Form not filled yet'
  const optional = unfilled.value.length - waitingRequired.value
  const check = a.filter(x => x.confidence !== 'high' && answerText(x.value)).length
  const parts = [plural(a.length, 'field')]
  if (waitingRequired.value) parts.push(`${waitingRequired.value} waiting on you`)
  if (optional) parts.push(`${optional} optional not filled`)
  if (check) parts.push(`${check} to check`)
  return parts.join(', ')
})
const formTone = computed(() => (props.item.form.error ? 'error' : waitingRequired.value ? 'warning' : 'default'))

const resumeSummary = computed(() => {
  const r = props.item.resume
  if (!r) return 'Not written yet'
  return `${plural(r.experience.length, 'role')}, ${plural(Object.values(r.skills).flat().length, 'skill')}`
})

const letterPreview = computed(() => {
  const text = props.item.coverLetter ?? ''
  const firstBody = text.split('\n').map(s => s.trim()).filter(Boolean)[1] ?? ''
  return text ? `${plural(text.split(/\s+/).length, 'word')}. ${firstBody}` : 'Not written yet'
})
</script>

<template>
  <article class="rc" :class="{ 'rc--fill': fill }" :aria-label="`${item.job.title} at ${item.job.company}`">
    <div class="rc__body">
      <header class="rc__head">
        <div class="rc__eyebrow">
          <span class="rc__company">{{ item.job.company }}</span>
          <span v-if="item.isSandbox" class="rc__sandbox" title="Test data or the sandbox employer. Nothing reaches a real company.">Sandbox</span>
          <span v-if="$slots.nav" class="rc__nav"><slot name="nav" /></span>
        </div>
        <component :is="titleTag ?? 'h1'" class="rc__title">{{ item.job.title }}</component>
        <!-- Desktop puts the meta line and the two links on one row (rc--fill); the phone stacks them. -->
        <div class="rc__sub">
        <div class="rc__meta">
          <!-- The state sits beside the facts it qualifies, never above the heading. -->
          <span class="rc__status" :class="`rc__status--${meta.color}`">{{ meta.label }}</span>
          <span v-for="f in facts" :key="f.text" class="rc__fact"><v-icon :icon="f.icon" size="14" class="rc__fact-icon" /> <span class="rc__fact-text">{{ f.text }}</span></span>
          <span v-if="item.proposedAt"><v-icon icon="mdi-clock-outline" size="14" /> Proposed {{ timeAgo(item.proposedAt) }}</span>
        </div>
        <div class="rc__links">
          <v-btn
            v-if="item.job.url"
            :href="item.job.url"
            target="_blank"
            rel="noopener"
            variant="tonal"
            :height="fill ? 32 : 44"
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
            :height="fill ? 32 : 44"
            append-icon="mdi-open-in-new"
            class="rc__form-link"
          >
            <span class="rc__form-text">Form on {{ hostOf(item.job.applyUrl) }}</span>
          </v-btn>
        </div>
        </div>
      </header>

      <div v-if="!isDecisionCard" class="rc__block">
        <ReviewProgress :item="item" :preparing="preparing" @prepare="emit('prepare')" />
      </div>

      <div v-if="!fill && showAnswerFirst" ref="answerFirst" class="rc__block rc__block--first">
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
          <ReviewScoreLedger v-if="item.score" :score="item.score" :dense="fill">
            <template #summary>
              <!-- Phone only: Matched and Missing under the score. Pay is said once, by the pay panel that follows. -->
              <div v-if="glance" class="rc__glance">
                <p class="rc__glance-line">
                  <span class="rc__glance-label">Matched</span> <span class="tabular">{{ glance.matched }}</span><span class="rc__glance-sep" aria-hidden="true"> · </span><span class="rc__glance-label">Missing:</span> <span :class="{ 'rc__glance-none': glance.none }">{{ glance.missing }}</span>
                </p>
              </div>
            </template>
          </ReviewScoreLedger>
          <p v-else class="rc__empty">Not scored yet.</p>
        </div>
        <div class="rc__panel">
          <ReviewCompFloor
            :comp="item.compensation"
            :score="item.score"
            :listing="{ min: item.job.salaryMin, max: item.job.salaryMax, currency: item.job.salaryCurrency }"
            compact
            :dense="fill"
          />
        </div>
        <!-- Desktop: Matched count and every Missing skill by its whole name, full width under the score and pay. -->
        <div v-if="fill && hasSkills" class="rc__strip">
          <p class="rc__strip-head">
            <span><span class="rc__strip-label">Matched</span> <span class="tabular">{{ sets.matched.length }}</span></span>
            <span><span class="rc__strip-label">Missing</span> <span class="tabular">{{ sets.missing.length }}</span></span>
            <span v-if="sets.missing.length" class="rc__strip-hint">Click one you have to say so.</span>
            <span v-else class="rc__strip-hint">Nothing missing.</span>
          </p>
          <div v-if="sets.missing.length" class="rc__strip-chips">
            <v-chip
              v-for="c in sets.missing"
              :key="c.text"
              tag="button"
              type="button"
              size="small"
              variant="outlined"
              prepend-icon="mdi-minus"
              append-icon="mdi-chevron-right"
              class="rc__strip-chip"
              :title="c.text !== c.name ? c.text : undefined"
              :aria-label="`${c.name}: say whether you have it`"
              @click="openClaim(c.text, c.source)"
            >
              {{ c.name }}
            </v-chip>
          </div>
          <p v-if="softLine" class="rc__strip-soft">
            <v-icon icon="mdi-account-voice" size="14" class="rc__strip-soft-icon" />
            <span>
              {{ softLine.count }}, not counted as missing: {{ softLine.names }}.
              <button v-if="softLine.asked" type="button" class="rc__strip-soft-link" @click="showSoftQuestions">{{ softLine.asked === 1 ? 'Asked as a question' : 'Asked as questions' }}</button>
            </span>
          </p>
        </div>
      </div>

      <!-- Desktop: the verdict and every Missing skill above, then the questions approve waits on. -->
      <div v-if="fill && showAnswerFirst" ref="answerFirstAfter" class="rc__block rc__block--after">
        <h2 class="rc__h">Answer first</h2>
        <ReviewQuestions
          :questions="blockingQs"
          :saving-id="savingQuestionId"
          :refreshing="refreshing"
          @answer="(id, a) => emit('answer', id, a)"
          @skip="id => emit('skip', id)"
        />
      </div>

      <!-- Stage 1: what the employer form asks that the knowledge base does not answer. Apply never waits on these. -->
      <div v-if="formQs.length" class="rc__block rc__block--after">
        <h2 class="rc__h rc__h--plain">The form asks</h2>
        <p class="rc__help">Answer now or after you apply. Your answers are saved to your profile and fill every form that asks.</p>
        <!-- The progress line shows once, under the last question section on the card. -->
        <ReviewQuestions
          :questions="formQs"
          :saving-id="savingQuestionId"
          :refreshing="refreshing && !skillQs.length"
          @answer="(id, a) => emit('answer', id, a)"
          @skip="id => emit('skip', id)"
        />
      </div>

      <!-- Stage 1: the gap plan's questions about skills and experience the knowledge base does not mention. -->
      <div v-if="skillQs.length" class="rc__block rc__block--after">
        <h2 class="rc__h rc__h--plain">Skills to confirm</h2>
        <p class="rc__help">The gap plan could not tell whether you have these. Answer now or after you apply; a Yes lets the resume and letter mention it.</p>
        <ReviewQuestions
          :questions="skillQs"
          :saving-id="savingQuestionId"
          :refreshing="refreshing"
          @answer="(id, a) => emit('answer', id, a)"
          @skip="id => emit('skip', id)"
        />
      </div>

      <div class="rc__sections">
        <ReviewSection title="Skills fit" icon="mdi-puzzle-outline" :summary="skillsSummary" default-open>
          <ReviewSkills :score="item.score" :requirements="item.requirements" :hide-missing="fill" @claim="openClaim" />
        </ReviewSection>

        <ReviewSection v-if="isStageOne" title="Gap plan" icon="mdi-map-marker-path" :summary="gapSummary" default-open>
          <DemoGapAnalysis :gap="item.gap" :show-summary="false" />
        </ReviewSection>

        <ReviewSection v-if="isStageOne" title="Employer form" icon="mdi-form-textbox" :summary="formReadSummary" :tone="item.form.error ? 'warning' : 'default'">
          <ReviewFormRead :answers="answers" :snapshot="item.form.snapshot" :form-error="item.form.error" :detail="item.form.snapshot || item.form.error ? null : item.statusDetail" />
        </ReviewSection>

        <ReviewSection title="Pay and benefits" icon="mdi-cash-multiple" :summary="paySummary">
          <ReviewCompFloor
            :comp="item.compensation"
            :score="item.score"
            :listing="{ min: item.job.salaryMin, max: item.job.salaryMax, currency: item.job.salaryCurrency }"
          />
        </ReviewSection>

        <ReviewSection v-if="item.demo && !isStageOne" ref="demoSection" title="Demo project" icon="mdi-source-repository" :summary="demoSummary" :tone="demoTone">
          <ReviewDemo :demo="item.demo" :effect="item.approveEffect" :company="company" />
          <p v-if="gapLine" class="rc__gap">Gap analysis: {{ gapLine }}</p>
        </ReviewSection>

        <ReviewSection
          v-if="!isStageOne"
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
            :question-hint="questionHint"
            :status="item.status"
            :submitted-at="item.submission?.submittedAt ?? null"
            :submit-method="item.submission?.method ?? null"
          />
        </ReviewSection>

        <ReviewSection v-if="!isStageOne" title="Resume" icon="mdi-file-account-outline" :summary="resumeSummary">
          <ReviewResume v-if="item.resume" :resume="item.resume" :pdf-url="item.resumePdfUrl" />
          <p v-else class="rc__empty">No tailored resume yet.</p>
        </ReviewSection>

        <ReviewSection v-if="!isStageOne" title="Cover letter" icon="mdi-email-outline" :summary="letterPreview">
          <template v-if="item.coverLetter">
            <div class="rc__doc-tools">
              <ReviewCopyButton :text="item.coverLetter" variant="tonal" label="Copy cover letter" />
            </div>
            <div class="rc__letter">{{ item.coverLetter }}</div>
          </template>
          <p v-else class="rc__empty">No cover letter yet.</p>
        </ReviewSection>

        <ReviewSection
          v-if="optionalQs.length"
          ref="optionalSection"
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

        <ReviewSection title="Full posting" icon="mdi-text-box-outline" :summary="item.job.descriptionText ? plural(item.job.descriptionText.split(/\s+/).length, 'word') : 'No text saved'">
          <ReviewPosting v-if="item.job.descriptionText" :text="item.job.descriptionText" class="rc__posting" />
        </ReviewSection>
      </div>
    </div>

    <SkillsClaimDialog
      v-model="claimOpen"
      :job-id="item.job.id"
      :application-id="item.applicationId"
      :target="claimTarget"
      :job="{ title: item.job.title, company: item.job.company }"
      :preparing="preparing"
      @changed="qid => emit('refresh', qid)"
      @prepare="emit('prepare')"
    />

    <ReviewDecisionBar
      class="rc__bar"
      :item="item"
      :approving="approving"
      :applying="applying"
      :refreshing="refreshing"
      :questions-place="questionsPlace"
      @approve="emit('approve')"
      @apply="emit('apply')"
      @reject="emit('reject')"
      @show-demo="demoSection?.show()"
      @show-questions="showQuestions"
    />
  </article>
</template>

<style scoped lang="scss">
.rc {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: rgb(var(--v-theme-surface));
  border-radius: 16px;

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
    font-weight: 500;
    line-height: 1.4;
    padding: 1px 8px;
    border-radius: 6px;
    white-space: nowrap;

    @each $c in primary, warning, error, success, secondary, info {
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
    color: rgb(var(--v-theme-on-surface));
    background: rgb(var(--v-theme-surface-light));
  }

  &__title {
    font-size: 1.25rem;
    font-weight: 600;
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

    > span {
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

  &__fact-text {
    min-width: 0;
  }

  &__sub {
    display: contents;
  }

  &__glance {
    display: none;
    flex-direction: column;
    gap: 4px;
    margin: -2px 0 10px;
    padding-bottom: 10px;
    border-bottom: 1px solid rgb(var(--v-theme-surface-light));
  }

  &__glance-line {
    margin: 0;
    font-size: 0.8125rem;
    line-height: 1.45;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
  }

  &__glance-label {
    font-weight: 600;
  }

  &__glance-sep,
  &__glance-none {
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__block {
    margin-top: 20px;

    &--after {
      margin-top: 16px;
    }
  }

  // Previous and Next on the card (desktop), at the end of the company line.
  &__nav {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    margin-left: auto;
  }

  // Desktop: the Matched count and every Missing skill across the card's width, under the score and pay.
  // Whole names (never cut) need the room, so the strip is tighter than the panels above it.
  &__strip {
    grid-column: 1 / -1;
    padding: 10px 14px 10px;
    border-radius: 10px;
    background: rgb(var(--v-theme-surface-bright));
  }

  &__strip-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 16px;
    margin: 0 0 6px;
    font-size: 0.875rem;
  }

  &__strip-label {
    font-weight: 600;
  }

  &__strip-hint {
    font-size: 0.75rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__strip-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 6px;

    // A whole name wraps inside its chip (two lines for a very long one), never an ellipsis.
    :deep(.v-chip) {
      max-width: 100%;
      height: auto;
      min-height: 22px;
      padding-top: 1px;
      padding-bottom: 1px;
      line-height: 1.3;
      white-space: normal;
    }
  }

  // Soft skills: one neutral line, never red chips, never in the Missing count.
  &__strip-soft {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    margin: 8px 0 0;
    font-size: 0.75rem;
    line-height: 1.45;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__strip-soft-icon {
    flex-shrink: 0;
    margin-top: 1px;
  }

  &__strip-soft-link {
    font: inherit;
    font-weight: 600;
    color: rgb(var(--v-theme-primary));
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;

    &:hover {
      text-decoration: underline;
    }
  }

  &__strip-chip {
    cursor: pointer;
    text-align: left;

    :deep(.v-chip__append) {
      margin-inline-start: 4px;
      opacity: 0.7;
    }
  }

  &__h {
    font-size: 0.875rem;
    font-weight: 600;
    margin: 0 0 8px;
    color: rgb(var(--v-theme-warning));

    // Stage 1's form questions hold nothing up, so they are not in the warning color.
    &--plain {
      color: rgb(var(--v-theme-on-surface));
      margin-bottom: 2px;
    }
  }

  &__help {
    margin: 0 0 8px;
    font-size: 0.8125rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__verdict {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 12px;
    margin: 20px 0 8px;
  }

  // Nested panels step up one lightness level from the card; no border.
  &__panel {
    padding: 16px;
    border-radius: 10px;
    background: rgb(var(--v-theme-surface-bright));
  }

  &__sections {
    margin-top: 12px;
  }

  &__gap {
    margin: 12px 0 0;
    font-size: 0.8125rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__posting {
    padding: 16px 18px;
    border-radius: 10px;
    background: rgb(var(--v-theme-sunken));
    max-height: 480px;
    overflow-y: auto;
  }

  &__doc-tools {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 8px;
  }

  &__letter {
    white-space: pre-line;
    font-size: 0.875rem;
    line-height: 1.65;
    padding: 16px 18px;
    border-radius: 10px;
    background: rgb(var(--v-theme-sunken));
    max-height: 480px;
    overflow-y: auto;
  }

  &__empty {
    margin: 0;
    font-size: 0.875rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__bar {
    border-radius: 0 0 16px 16px;
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

  // Desktop: the meta line and Posting and Form share a row, so the verdict and Missing list fit the first screen.
  &--fill &__sub {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 16px;
  }

  &--fill &__links {
    margin: 0;
    flex-wrap: nowrap;
  }

  &--fill &__verdict {
    margin-top: 10px;
    gap: 10px;
  }
}

@media (max-width: 599.98px) {
  .rc {
    border-radius: 12px;

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

    // Decide without scrolling: the summary under the score, a long location list cut to two
    // lines, and Posting and Form on one row.
    &__glance {
      display: flex;
    }

    &__fact {
      align-items: flex-start !important;
      min-width: 0;
    }

    &__fact-icon {
      margin-top: 2px;
    }

    &__fact-text {
      display: -webkit-box;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      line-clamp: 2;
      overflow: hidden;
    }

    &__links {
      flex-wrap: nowrap;
      margin-top: 10px;
    }

    &__form-link {
      flex: 0 1 auto;
      min-width: 0;

      :deep(.v-btn__content) {
        min-width: 0;
      }
    }

    &__form-text {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    &__bar {
      border-radius: 0 0 12px 12px;
    }
  }
}
</style>

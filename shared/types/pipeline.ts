// Shared contract between the server pipeline and the review dashboard.
// Every JSON column added in migration 0001 stores one of these shapes.
// Change a shape here first, then the code that writes it, then the code that reads it.

import type { RepoSuggestionView } from './repos'

export type AtsType =
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'workable'
  | 'smartrecruiters'
  | 'recruitee'
  | 'bamboohr'
  | 'jobvite'
  | 'workday'
  | 'icims'
  | 'taleo'
  | 'successfactors'
  | 'sandbox'
  | 'other'
  | 'unknown'

/** ATS platforms that make the applicant create an account. The pipeline never creates one. */
export const ACCOUNT_REQUIRED_ATS: readonly AtsType[] = ['workday', 'icims', 'taleo', 'successfactors']

// ── Compensation ─────────────────────────────────────────────

export type BenefitCategory =
  | 'health'
  | 'dental_vision'
  | 'retirement'
  | 'pto'
  | 'parental'
  | 'learning'
  | 'equipment'
  | 'wellness'
  | 'remote_stipend'
  | 'insurance'
  | 'other'

export interface Benefit {
  name: string
  category: BenefitCategory
  detail: string
  /** Annual dollar value when the posting states it or a stated figure implies it. Null when it would be a guess. */
  estimatedAnnualValue: number | null
  /** Exact text from the posting this benefit came from. */
  quote: string
}

export interface CompensationBreakdown {
  currency: string
  baseMin: number | null
  baseMax: number | null
  basePeriod: 'year' | 'month' | 'hour' | null
  /** Exact text from the posting the base pay came from. */
  baseQuote?: string | null
  /** Base salary converted to a yearly figure. */
  baseAnnualMin: number | null
  baseAnnualMax: number | null
  bonus: { description: string; estimatedAnnual: number | null; quote: string } | null
  equity: { description: string; estimatedAnnual: number | null; quote: string } | null
  benefits: Benefit[]
  /** Base plus bonus plus equity plus valued benefits, yearly. */
  totalEstimateMin: number | null
  totalEstimateMax: number | null
  /** stated: the posting gives a salary range. partial: some numbers. not_stated: no pay information. */
  confidence: 'stated' | 'partial' | 'not_stated'
  notes: string
  extractedAt: string
}

// ── Requirements and scoring ─────────────────────────────────

export interface Requirement {
  text: string
  kind: 'skill' | 'language' | 'framework' | 'experience' | 'domain' | 'education' | 'certification' | 'other'
  mustHave: boolean
  /** Judged against the knowledge base only. */
  status: 'have' | 'partial' | 'lack' | 'unknown'
  /** Knowledge base entry that supports a have or partial status. */
  evidence: string | null
}

export interface ScoreComponent {
  label: string
  points: number
  detail: string
  ruleId?: number
}

export interface ScoreBreakdown {
  final: number
  skills: {
    score: number
    reasoning: string
    matched: string[]
    missing: string[]
    /** The parts the skills score is summed from: must-haves 0 to 45, stack 0 to 25, seniority 0 to 20, domain 0 to 10. */
    parts?: { mustHaves: number; stack: number; seniority: number; domain: number }
  }
  compensation: {
    score: number | null
    reasoning: string
    floor: number | null
    /** Target salary from the knowledge base, when one is set. */
    target?: number | null
    estimate: number | null
    meetsFloor: boolean | null
  }
  learned: { total: number; components: ScoreComponent[] }
  weights: { skills: number; compensation: number }
  recommendation: 'strong_match' | 'good_match' | 'partial_match' | 'weak_match'
  computedAt: string
}

// ── Resume ───────────────────────────────────────────────────

export interface TailoredResume {
  summary: string
  experience: Array<{
    company: string
    title: string
    period: string
    bullets: string[]
  }>
  skills: Record<string, string[]>
  education: Array<{
    institution: string
    degree: string
    year: string
  }>
  /** Demo projects or knowledge base projects listed on this resume. */
  projects?: Array<{ name: string; description: string; url?: string | null }>
  tailoringNotes: string
  generatedQuestions: Array<{
    question: string
    context: string
    category: string
  }>
}

// ── Employer application forms ───────────────────────────────

export type FormFieldType =
  | 'text'
  | 'email'
  | 'tel'
  | 'url'
  | 'number'
  | 'date'
  | 'textarea'
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'checkbox_group'
  | 'file'
  | 'unknown'

export interface FormField {
  /** Stable id within the snapshot, used by FormAnswer.fieldId. */
  id: string
  /** CSS selector Playwright uses to reach the control. */
  selector: string
  label: string
  type: FormFieldType
  required: boolean
  options?: string[]
  maxLength?: number | null
  section?: string | null
  /** Gender, race, veteran, disability and similar voluntary self-identification questions. */
  isEeo?: boolean
}

export type AnswerSource =
  | 'knowledge'
  | 'resume'
  | 'cover_letter'
  | 'generated'
  | 'question'
  | 'eeo_decline'
  | 'skipped'

export interface FormAnswer {
  fieldId: string
  label: string
  value: string | string[] | boolean | null
  source: AnswerSource
  /** Knowledge base key, question id, or other pointer to where the value came from. */
  sourceDetail?: string | null
  confidence: 'high' | 'medium' | 'low'
  /** Set when the value needs Devin's answer before the application can be approved. */
  needsQuestionId?: number | null
  filled: boolean
  fillError?: string | null
}

export interface FormSnapshot {
  url: string
  finalUrl: string
  atsType: AtsType
  title: string | null
  fields: FormField[]
  capturedAt: string
  requiresAccount: boolean
  /** Captcha, login wall, closed posting, and anything else that stops an automated submit. */
  blockers: string[]
}

// ── Gap analysis and demo projects ───────────────────────────

export interface GapItem {
  requirement: string
  mustHave: boolean
  decision: 'demo' | 'reframe' | 'ask' | 'skip'
  rationale: string
  demoIdea?: { title: string; summary: string; stack: string[]; scopeHours: number } | null
  questionId?: number | null
}

export interface GapAnalysis {
  items: GapItem[]
  demoRecommended: boolean
  summary: string
  analyzedAt: string
}

export type DemoStatus =
  | 'proposed'
  | 'building'
  | 'built'
  | 'failed'
  | 'publishing'
  | 'published'
  | 'discarded'

export interface DemoFile {
  path: string
  bytes: number
}

// ── Applications and review ──────────────────────────────────

export type ApplicationStatus =
  // pipeline states
  | 'preparing'
  | 'needs_input'
  | 'proposed'
  | 'approved'
  | 'publishing'
  | 'submitting'
  | 'submitted'
  | 'submit_failed'
  | 'needs_manual'
  | 'declined'
  // states from the original app, kept for existing rows and manual tracking
  | 'draft'
  | 'ready'
  // what the employer did after the application went out (shared/utils/outcomes.ts)
  | 'response_received'
  | 'interviewing'
  | 'rejected'
  | 'offer'
  | 'no_response'

/** What the employer did after the application went out. Only these and "I submitted it" are set through PATCH. */
export type OutcomeStatus = 'response_received' | 'interviewing' | 'rejected' | 'offer' | 'no_response'

/**
 * One line of an application's outcome history: an employer outcome, or "I submitted it" (status
 * submitted). Stored as a decisions row with decision 'outcome' (server/utils/outcomes.ts).
 */
export interface OutcomeEntry {
  id: number
  status: OutcomeStatus | 'submitted'
  /** The day it happened, as Devin gave it: YYYY-MM-DD, no time and no zone. */
  date: string
  note: string | null
  previousStatus: string | null
  /** When it was recorded (SQLite UTC timestamp). */
  recordedAt: string
  isSandbox: boolean
}

/** PATCH /api/applications/:id body when it changes the status. */
export interface ApplicationOutcomeRequest {
  status: OutcomeStatus | 'submitted'
  /** YYYY-MM-DD; today when absent. */
  date?: string | null
  /** Optional note kept with this line of the history. Not the application's notes. */
  note?: string | null
}

export interface SubmissionResult {
  method: 'automated' | 'manual'
  /** For a manual result: when it was handed back, then, once byHand is set, the day Devin gave. */
  submittedAt: string
  /** Devin said he submitted it himself on the employer's site ("I submitted it"). */
  byHand?: boolean
  finalUrl: string | null
  confirmationText: string | null
  /** Path under the data directory. */
  screenshotPath: string | null
  /** True when the target was the sandbox form instead of a real employer. */
  sandbox: boolean
  /** Why method is 'manual': captcha, account required, real submits switched off, and similar. */
  manualReason?: string | null
}

export const REJECT_REASONS = [
  { code: 'comp_too_low', label: 'Pay too low' },
  { code: 'not_remote', label: 'Not remote' },
  { code: 'wrong_stack', label: 'Wrong tech stack' },
  { code: 'too_junior', label: 'Too junior' },
  { code: 'too_senior', label: 'Too senior or pure management' },
  { code: 'company', label: 'Not this company' },
  { code: 'industry', label: 'Not this industry' },
  { code: 'location', label: 'Location or time zone' },
  { code: 'weak_materials', label: 'Resume or letter not good enough' },
  { code: 'already_applied', label: 'Already applied' },
  { code: 'other', label: 'Other' },
] as const

export type RejectReasonCode = (typeof REJECT_REASONS)[number]['code']

/**
 * A "Wrong tech stack" rejection can name the skills that are the problem.
 * lack: Devin does not have them (written to the knowledge base as a No).
 * avoid: he has them but does not want to work with them (learning only).
 */
export type RejectSkillsMode = 'lack' | 'avoid'

/** One skill the reject dialog offers as a chip, taken from the job's requirements. */
export interface RejectSkillOption {
  /** Short skill name shown on the chip and sent back in the reject body. */
  label: string
  /** The requirement's status against the knowledge base: lack and unknown first, then partial, then have. */
  status: Requirement['status']
  /** The requirement text the skill came from. */
  requirement: string
}

/** decisions.features_json.rejectSkills: what a wrong_stack rejection named, and what it wrote. */
export interface RejectSkillsRecord {
  mode: RejectSkillsMode
  /** kept: the knowledge base lists this skill as one Devin has, so "I don't have these" leaves it there and only lowers jobs. */
  skills: Array<{ value: string; label: string; term: string; kept?: boolean }>
  /** Filled after the knowledge step ran (lack only). */
  knowledge?: {
    written: Array<{ category: string; key: string; replaced: string | null }>
    questionsAnswered: number[]
    errors: string[]
  }
}

export interface QuestionView {
  id: number
  question: string
  context: string | null
  kind: string | null
  subject: string | null
  answerType: 'yes_no' | 'text' | 'number' | 'choice' | null
  choices: string[] | null
  blocking: boolean
  status: string
  answer: string | null
  /** Pending knows or has_done question with evidence from Devin's own GitHub commits. Null when there is none. */
  repoSuggestion?: RepoSuggestionView | null
}

export interface DemoProjectView {
  id: number
  slug: string
  title: string
  summary: string | null
  gapAddressed: string | null
  techStack: string[]
  status: DemoStatus
  repoName: string | null
  repoUrl: string | null
  liveUrl: string | null
  files: DemoFile[]
  readme: string | null
  testCommand: string | null
  testOutput: string | null
  testsPassed: boolean | null
  error: string | null
}

/** GET /api/demos/:id. The demo plus what the detail page needs around it. */
export interface DemoDetail extends DemoProjectView {
  /** What approving the application would do (see ReviewItem.approveEffect); null when the application is gone. */
  approveEffect?: { submit: 'sandbox' | 'automatic' | 'manual'; manualReason: string | null; demoBlocked: string | null } | null
  applicationId: number
  jobId: number
  isSandbox: boolean
  applicationStatus: ApplicationStatus
  job: { title: string; company: string }
  /** https://github.com/<owner>/<repoName>, the URL the repo gets on publish (sandbox publishes go to local bare repos instead). */
  plannedRepoUrl: string | null
  costUsd: number | null
  buildLog: string | null
  createdAt: string
  builtAt: string | null
  publishedAt: string | null
  gapItem: GapItem | null
  /** The application's whole gap analysis, for context on the detail page. */
  gap: GapAnalysis | null
  /** Present while a build or a preview build runs in this server process. Null after a restart. */
  progress: DemoBuildProgress | null
  /** Why a failed build stopped, when the daily run retries it on its own: out of credit, key rejected, or daily budget. */
  stoppedFor: 'credit' | 'key' | 'budget' | null
  /** Failed, and the application's current gap analysis no longer plans this demo: it will not be retried. */
  noLongerPlanned: boolean
  /** Why it is no longer planned, from the current gap analysis. */
  notNeededReason: string | null
  preview: DemoPreview
}

/** A build running now, kept in the server's memory. */
export interface DemoBuildProgress {
  /** build: Claude is writing the project; preview: the harness is building the preview or running the tests. */
  phase: 'build' | 'preview'
  startedAt: string
  turn: number
  maxTurns: number
  /** The newest build log lines, oldest first. */
  recent: string[]
}

export interface DemoTestCase {
  name: string
  /** The describe block or file the test sits in, when the runner reports one. */
  suite: string | null
  status: 'passed' | 'failed' | 'skipped'
  durationMs: number | null
}

/**
 * What a demo does, shown on its detail page: a static build of its web UI served from
 * /demo-preview/<id>/<token>/, or, for a library or service without a UI, its test list.
 */
export interface DemoPreview {
  /** web: index.html plus a Vite build. tests: no UI, so the tests show what it does. none: nothing on disk yet. */
  kind: 'web' | 'tests' | 'none'
  /** The program that produced it: vite, vitest, jest, node --test, go test. */
  tool: string | null
  /** building comes from memory; ready and failed from the cached result next to the demo. */
  status: 'missing' | 'building' | 'ready' | 'failed'
  /** Public, token-checked URL of a ready web preview (works without a login). */
  url: string | null
  builtAt: string | null
  error: string | null
  tests: DemoTestCase[] | null
  /** One line on why there is no web preview, or what the preview needs. */
  note: string | null
}

export interface ReviewItem {
  applicationId: number
  status: ApplicationStatus
  statusDetail: string | null
  proposedAt: string | null
  isSandbox: boolean
  job: {
    id: number
    title: string
    company: string
    location: string | null
    remoteType: string | null
    source: string
    url: string | null
    applyUrl: string | null
    atsType: AtsType | null
    foundAt: string
    salaryMin: number | null
    salaryMax: number | null
    salaryCurrency: string | null
    descriptionText: string | null
  }
  score: ScoreBreakdown | null
  compensation: CompensationBreakdown | null
  requirements: Requirement[]
  /** Skills the reject dialog offers under "Wrong tech stack", in display order. */
  rejectSkillOptions: RejectSkillOption[]
  resume: TailoredResume | null
  resumePdfUrl: string | null
  coverLetter: string | null
  form: {
    snapshot: FormSnapshot | null
    answers: FormAnswer[]
    screenshotUrl: string | null
    filledAt: string | null
    error: string | null
  }
  gap: GapAnalysis | null
  demo: DemoProjectView | null
  openQuestions: QuestionView[]
  /** What approve will do for this application, decided on the server from its settings and form. */
  approveEffect: {
    submit: 'sandbox' | 'automatic' | 'manual'
    manualReason: string | null
    demoBlocked: string | null
  }
  submission: SubmissionResult | null
  submitError: string | null
}

export interface PipelineRunView {
  id: number
  task: string
  trigger: string
  status: 'running' | 'succeeded' | 'failed' | 'skipped'
  startedAt: string
  finishedAt: string | null
  stats: Record<string, unknown> | null
  error: string | null
  host: string | null
  /** Derived from status and stats: a finished run with failed items or a budget or credit stop is partial. */
  outcome?: 'running' | 'succeeded' | 'partial' | 'failed' | 'skipped'
  /** What went wrong, a few plain words each ("38 failed", "stopped: out of credit"). Empty when clean. */
  problems?: string[]
}

// ── Skill claims: tap a Missing skill to say you have it ─────

/** Where the tapped text came from: a Missing chip of the skills score, or a posting requirement row. */
export type SkillClaimSource = 'missing' | 'requirement'

/** The three answers the skill panel offers. They are the yes or no answers of a knows or has_done question. */
export const SKILL_CLAIM_ANSWERS = ['Yes', 'Some experience', 'No'] as const
export type SkillClaimAnswer = (typeof SKILL_CLAIM_ANSWERS)[number]

/** The knowledge base entry an answer replaces or adds to, as stored. */
export interface SkillClaimKnowledge {
  category: string
  key: string
  value: string
}

/** GET /api/jobs/:id/claim?text=&source=&applicationId=: what the skill panel shows before Devin answers. */
export interface SkillClaimPreview {
  /** The plain skill or experience name: the tapped text without its parenthetical reason. */
  name: string
  /** Why it shows as missing, in plain words. Null when nothing says why. */
  why: string | null
  /** The posting requirement this is about, when it is not the same words as the name. */
  requirement: string | null
  /**
   * The question the answer goes to: an existing one on the same subject (pending, answered, or
   * skipped), or the one a save creates (id null).
   */
  question: {
    id: number | null
    text: string
    kind: 'knows' | 'has_done'
    subject: string
    status: string | null
    answer: string | null
    /** The example saved with an answered Yes or Some experience. */
    example: string | null
    /** A pending question's suggestion from Devin's own GitHub commits. Null when there is none. */
    repoSuggestion?: RepoSuggestionView | null
  }
  /** The knowledge base entry on this subject today. Null when the knowledge base says nothing. */
  knowledge: SkillClaimKnowledge | null
  /** Sandbox jobs never write the knowledge base and never create questions. */
  isSandbox: boolean
  /** The application whose resume and cover letter an answer can make stale. Null without one. */
  materials: {
    applicationId: number
    /** The resume or the cover letter is written. */
    written: boolean
    /** POST /api/applications/:id/prepare accepts this application's status. */
    canPrepare: boolean
  } | null
}

/** POST /api/jobs/:id/claim body. */
export interface SkillClaimRequest {
  text: string
  source: SkillClaimSource
  applicationId?: number | null
  answer: SkillClaimAnswer
  /** Where he did it, stored exactly as typed. Absent keeps a saved one; only Yes and Some experience take it. */
  example?: string | null
}

/** POST /api/jobs/:id/claim result. */
export interface SkillClaimResult {
  /** False on a sandbox job: nothing was written and no question was created. */
  written: boolean
  question: QuestionView | null
  /** The entry as it reads after the answer. */
  knowledge: SkillClaimKnowledge | null
  /** Posting requirements of this job whose status the answer changed. */
  requirementsChanged: number
}

/** POST /api/jobs/:id/rescore: a fresh skills score from Claude for one job. */
export interface JobRescoreResult {
  ok: boolean
  /** Why the score did not change: out of budget, a refused call, and similar. Null when ok. */
  message: string | null
  score: ScoreBreakdown | null
  requirements: Requirement[]
  matchScore: number | null
  previousScore: number | null
}

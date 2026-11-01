import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

export const jobs = sqliteTable('jobs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  source: text('source').notNull(), // jsearch, adzuna, remotive, etc.
  sourceId: text('source_id').notNull(),
  title: text('title').notNull(),
  company: text('company').notNull(),
  companyUrl: text('company_url'),
  location: text('location'),
  remoteType: text('remote_type'), // remote, hybrid, onsite
  salaryMin: real('salary_min'),
  salaryMax: real('salary_max'),
  salaryCurrency: text('salary_currency'),
  description: text('description'),
  url: text('url'),
  tags: text('tags'), // JSON array stored as text
  matchScore: integer('match_score'),
  matchReasoning: text('match_reasoning'),
  status: text('status').notNull().default('new'), // new, reviewed, applied, rejected, expired
  foundAt: text('found_at').notNull().default(sql`(datetime('now'))`),
  expiresAt: text('expires_at'),
  // Enrichment (migration 0001)
  applyUrl: text('apply_url'), // the employer's application form, resolved from the listing
  atsType: text('ats_type'), // AtsType in shared/types/pipeline.ts
  atsMeta: text('ats_meta'), // JSON: board token, posting id, anything the ATS adapter needs
  postingText: text('posting_text'), // full posting as plain text, fetched from the employer when possible
  enrichedAt: text('enriched_at'),
  enrichError: text('enrich_error'),
  compJson: text('comp_json'), // CompensationBreakdown
  totalCompEstimate: real('total_comp_estimate'), // midpoint of the total compensation estimate, yearly
  requirementsJson: text('requirements_json'), // Requirement[]
  // Scoring (migration 0001). match_score above stays the final score so existing pages keep working.
  skillsScore: integer('skills_score'),
  compScore: integer('comp_score'),
  learnedAdjustment: integer('learned_adjustment'),
  scoreBreakdown: text('score_breakdown'), // ScoreBreakdown
  scoredAt: text('scored_at'),
  isSandbox: integer('is_sandbox', { mode: 'boolean' }).notNull().default(false),
}, (table) => [
  index('jobs_source_source_id_idx').on(table.source, table.sourceId),
  index('jobs_status_idx').on(table.status),
  index('jobs_match_score_idx').on(table.matchScore),
  index('jobs_company_idx').on(table.company),
  index('jobs_ats_type_idx').on(table.atsType),
  index('jobs_found_at_idx').on(table.foundAt),
])

export const applications = sqliteTable('applications', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jobId: integer('job_id').notNull().references(() => jobs.id),
  tailoredResumeJson: text('tailored_resume_json'), // JSON of the tailored resume
  tailoredResumePdfPath: text('tailored_resume_pdf_path'),
  coverLetter: text('cover_letter'),
  tailoringNotes: text('tailoring_notes'),
  status: text('status').notNull().default('draft'), // ApplicationStatus in shared/types/pipeline.ts
  submittedAt: text('submitted_at'),
  responseAt: text('response_at'),
  notes: text('notes'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  // Pipeline (migration 0001)
  statusDetail: text('status_detail'), // one human-readable line on what is happening or what is missing
  isSandbox: integer('is_sandbox', { mode: 'boolean' }).notNull().default(false),
  formSnapshotJson: text('form_snapshot_json'), // FormSnapshot
  answersJson: text('answers_json'), // FormAnswer[]
  formScreenshotPath: text('form_screenshot_path'), // under the data directory
  formFilledAt: text('form_filled_at'),
  formError: text('form_error'),
  gapAnalysisJson: text('gap_analysis_json'), // GapAnalysis
  proposedAt: text('proposed_at'),
  decidedAt: text('decided_at'),
  submissionJson: text('submission_json'), // SubmissionResult
  submitError: text('submit_error'),
  submitAttempts: integer('submit_attempts').notNull().default(0),
}, (table) => [
  index('applications_job_id_idx').on(table.jobId),
  index('applications_status_idx').on(table.status),
])

export const knowledgeEntries = sqliteTable('knowledge_entries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  category: text('category').notNull(), // profile, experience, skill, preference, project, education, personal
  key: text('key').notNull(),
  value: text('value').notNull(),
  source: text('source').notNull().default('user_answer'), // resume, user_answer, inferred
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('knowledge_entries_category_idx').on(table.category),
])

export const questions = sqliteTable('questions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  question: text('question').notNull(),
  context: text('context'), // why this question is being asked
  category: text('category'), // technical, behavioral, preference
  applicationId: integer('application_id').references(() => applications.id),
  status: text('status').notNull().default('pending'), // pending, answered, skipped
  answer: text('answer'),
  askedAt: text('asked_at').notNull().default(sql`(datetime('now'))`),
  answeredAt: text('answered_at'),
  // Learning (migration 0001)
  kind: text('kind'), // has_done, knows, preference, fact, form_field, other
  subject: text('subject'), // the skill, language, or fact the question is about, e.g. "Rust"
  knowledgeKey: text('knowledge_key'), // "category:key" the answer is written to
  jobId: integer('job_id').references(() => jobs.id),
  blocking: integer('blocking', { mode: 'boolean' }).notNull().default(false), // an application waits on it
  answerType: text('answer_type'), // yes_no, text, number, choice
  choicesJson: text('choices_json'), // string[]
  dedupeKey: text('dedupe_key'), // normalized subject, so the same thing is never asked twice
}, (table) => [
  index('questions_status_idx').on(table.status),
  index('questions_dedupe_key_idx').on(table.dedupeKey),
  index('questions_application_id_idx').on(table.applicationId),
])

export const searchConfigs = sqliteTable('search_configs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  keywords: text('keywords').notNull(), // JSON array
  excludedKeywords: text('excluded_keywords'), // JSON array
  locations: text('locations'), // JSON array
  remoteOnly: integer('remote_only', { mode: 'boolean' }).default(false),
  salaryMin: real('salary_min'),
  salaryCurrency: text('salary_currency').default('USD'),
  jobSources: text('job_sources'), // JSON array of source names
  isActive: integer('is_active', { mode: 'boolean' }).default(true),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
})

// ── Migration 0001: pipeline, learning, demo projects, observability ──

export const decisions = sqliteTable('decisions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  applicationId: integer('application_id').notNull().references(() => applications.id),
  jobId: integer('job_id').notNull().references(() => jobs.id),
  decision: text('decision').notNull(), // approve, reject
  reasonCode: text('reason_code'), // RejectReasonCode, null on approve
  reasonText: text('reason_text'),
  featuresJson: text('features_json'), // snapshot of the job's features at decision time, for learning
  isSandbox: integer('is_sandbox', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('decisions_job_id_idx').on(table.jobId),
  index('decisions_reason_code_idx').on(table.reasonCode),
  index('decisions_created_at_idx').on(table.createdAt),
])

export const learnedRules = sqliteTable('learned_rules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind').notNull(), // keyword, title, company, industry, remote_type, location, tech, comp_floor, seniority, source, ats
  pattern: text('pattern').notNull(), // value the rule matches, lowercased
  effect: text('effect').notNull(), // score, exclude_search, boost_search
  weight: integer('weight').notNull().default(0), // score points added to the final score (negative lowers it)
  evidenceCount: integer('evidence_count').notNull().default(0),
  reasonCode: text('reason_code'),
  explanation: text('explanation'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('learned_rules_kind_pattern_idx').on(table.kind, table.pattern, table.effect),
  index('learned_rules_active_idx').on(table.active),
])

export const demoProjects = sqliteTable('demo_projects', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  applicationId: integer('application_id').notNull().references(() => applications.id),
  jobId: integer('job_id').notNull().references(() => jobs.id),
  slug: text('slug').notNull(),
  title: text('title').notNull(),
  summary: text('summary'),
  gapAddressed: text('gap_addressed'),
  techStackJson: text('tech_stack_json'), // string[]
  status: text('status').notNull().default('proposed'), // DemoStatus
  localPath: text('local_path'), // under the data directory, a git repo with one or more commits
  repoName: text('repo_name'),
  repoUrl: text('repo_url'), // set only after publish
  liveUrl: text('live_url'), // set only after publish
  filesJson: text('files_json'), // DemoFile[]
  readme: text('readme'),
  testCommand: text('test_command'),
  testOutput: text('test_output'),
  testsPassed: integer('tests_passed', { mode: 'boolean' }),
  buildLog: text('build_log'),
  costUsd: real('cost_usd'),
  error: text('error'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  builtAt: text('built_at'),
  publishedAt: text('published_at'),
}, (table) => [
  index('demo_projects_application_id_idx').on(table.applicationId),
  index('demo_projects_status_idx').on(table.status),
])

export const pipelineRuns = sqliteTable('pipeline_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  task: text('task').notNull(),
  trigger: text('trigger').notNull().default('schedule'), // schedule, manual, chained
  status: text('status').notNull().default('running'), // running, succeeded, failed, skipped
  startedAt: text('started_at').notNull().default(sql`(datetime('now'))`),
  finishedAt: text('finished_at'),
  statsJson: text('stats_json'),
  error: text('error'),
  host: text('host'), // os.hostname(), proves which container ran it
}, (table) => [
  index('pipeline_runs_task_idx').on(table.task),
  index('pipeline_runs_started_at_idx').on(table.startedAt),
])

export const scoreHistory = sqliteTable('score_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jobId: integer('job_id').notNull().references(() => jobs.id),
  score: integer('score').notNull(),
  skillsScore: integer('skills_score'),
  compScore: integer('comp_score'),
  learnedAdjustment: integer('learned_adjustment'),
  breakdownJson: text('breakdown_json'),
  reason: text('reason').notNull().default('initial'), // initial, rescore, rule_change
  computedAt: text('computed_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('score_history_job_id_idx').on(table.jobId),
  index('score_history_computed_at_idx').on(table.computedAt),
])

export const sandboxSubmissions = sqliteTable('sandbox_submissions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  token: text('token').notNull(),
  payloadJson: text('payload_json').notNull(),
  filesJson: text('files_json'), // [{ field, filename, bytes, path }]
  userAgent: text('user_agent'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
})

export const aiCalls = sqliteTable('ai_calls', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  purpose: text('purpose').notNull(),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
  costUsd: real('cost_usd').notNull().default(0),
  refType: text('ref_type'),
  refId: integer('ref_id'),
  error: text('error'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('ai_calls_created_at_idx').on(table.createdAt),
])

import { sqliteTable, text, integer, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core'
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
  // Migration 0006 (data-sources): when the source says the listing was posted or last updated
  // (UTC, same format as found_at), and the job this one repeats from another source. A duplicate
  // is stored (dedupe stays source + source_id) but never read or scored; the Jobs page lists it
  // as "Also on <source>" on the job it repeats.
  postedAt: text('posted_at'),
  duplicateOf: integer('duplicate_of'),
}, (table) => [
  index('jobs_source_source_id_idx').on(table.source, table.sourceId),
  index('jobs_duplicate_of_idx').on(table.duplicateOf),
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
  // Leads from Devin's past Claude sessions (migration 0003): QuestionMemoryLeads in shared/types/memory.ts.
  // The only place memory excerpts are stored; never copied into answers or the knowledge base.
  memoryLeadsJson: text('memory_leads_json'),
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
  // Migration 0002: rules learned from sandbox test decisions apply only to sandbox jobs
  isSandbox: integer('is_sandbox', { mode: 'boolean' }).notNull().default(false),
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
  // Migration 0007: tokens written to the prompt cache (usage.cache_creation_input_tokens).
  cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
  // Dollars billed to the API key. A call on Devin's subscription bills nothing here (0).
  costUsd: real('cost_usd').notNull().default(0),
  // Migration 0008: which backend served the call ('api': the Console key; 'agent': Devin's
  // subscription through the Claude Agent SDK) and, for agent calls, the SDK's cost estimate.
  backend: text('backend').notNull().default('api'),
  estCostUsd: real('est_cost_usd').notNull().default(0),
  refType: text('ref_type'),
  refId: integer('ref_id'),
  error: text('error'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('ai_calls_created_at_idx').on(table.createdAt),
])

// ── Migration 0003: GitHub evidence (server/utils/repos). CREATE TABLE only. ──
// Only Devin's own commits count as evidence. These tables hold what the indexer read from the
// repos he switched on in Settings: commit metadata (never diffs), languages, and dependency
// names. Tokens are never stored. token_index points at a position in the configured list.

export const repoSources = sqliteTable('repo_sources', {
  fullName: text('full_name').primaryKey(), // owner/name as GitHub returns it
  owner: text('owner').notNull(),
  name: text('name').notNull(),
  ownerType: text('owner_type'), // User or Organization
  isPrivate: integer('is_private', { mode: 'boolean' }).notNull().default(false),
  isFork: integer('is_fork', { mode: 'boolean' }).notNull().default(false),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  sizeKb: integer('size_kb'),
  defaultBranch: text('default_branch'),
  htmlUrl: text('html_url'),
  pushedAt: text('pushed_at'),
  tokenIndex: integer('token_index'), // which configured read token sees this repo (0-based)
  included: integer('included', { mode: 'boolean' }), // null: never switched, the owner default applies
  listedAt: text('listed_at'), // last time a token listed it. Older rows are repos the tokens lost.
  headSha: text('head_sha'),
  indexedAt: text('indexed_at'),
  commitCount: integer('commit_count'),
  skipReason: text('skip_reason'), // too large, empty
  indexError: text('index_error'),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('repo_sources_owner_idx').on(table.owner),
])

export const repoCommits = sqliteTable('repo_commits', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  repo: text('repo').notNull(), // repo_sources.full_name
  sha: text('sha').notNull(),
  authoredAt: text('authored_at').notNull(),
  authorName: text('author_name'),
  authorEmail: text('author_email'),
  message: text('message').notNull(),
  pathsJson: text('paths_json'), // string[] of changed paths
  url: text('url').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('repo_commits_repo_sha_idx').on(table.repo, table.sha),
  index('repo_commits_authored_at_idx').on(table.authoredAt),
])

export const repoFacts = sqliteTable('repo_facts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  repo: text('repo').notNull(),
  kind: text('kind').notNull(), // language, dependency
  name: text('name').notNull(),
  detail: text('detail'), // manifest path for a dependency, bytes for a language
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('repo_facts_repo_idx').on(table.repo),
  index('repo_facts_kind_name_idx').on(table.kind, table.name),
])

export const repoSuggestions = sqliteTable('repo_suggestions', {
  questionId: integer('question_id').primaryKey().references(() => questions.id),
  status: text('status').notNull(), // suggested, none, error
  subject: text('subject'),
  termsJson: text('terms_json'), // string[] the subject was expanded into
  level: text('level'), // Yes or Some experience, never No
  draft: text('draft'),
  evidenceJson: text('evidence_json'), // RepoEvidence[]
  commitShasJson: text('commit_shas_json'), // the hit set the suggestion was judged from
  error: text('error'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
})

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
})

// Durable job queue (migration 0005). Every scheduled run, manual trigger, and background job is a
// row here; a worker process claims the oldest due row with a lease and runs it. A daily run is a
// parent row with one child row per step. Times are UTC, 'YYYY-MM-DD HH:MM:SS' like datetime('now').
export const taskQueue = sqliteTable('task_queue', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  task: text('task').notNull(), // a Nitro task name, or applications:approve, demos:rebuild, ...
  payloadJson: text('payload_json'),
  trigger: text('trigger').notNull().default('manual'), // schedule, manual, chained
  status: text('status').notNull().default('queued'), // QueueStatus in shared/types/pipeline.ts
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: text('lease_expires_at'),
  runAfter: text('run_after').notNull().default(sql`(datetime('now'))`),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
  pipelineRunId: integer('pipeline_run_id'),
  parentId: integer('parent_id'),
  lastError: text('last_error'), // one plain sentence (plainError)
  note: text('note'), // "Resumed after a restart", shown beside the item
  progressJson: text('progress_json'), // live progress the worker shares with the web process
  resultJson: text('result_json'), // what the item returned, for callers that wait on it
}, (table) => [
  index('task_queue_status_run_after_idx').on(table.status, table.runAfter),
  index('task_queue_parent_idx').on(table.parentId),
])

// ── Migration 0006: incremental job source pulls and discovered boards (data-sources unit) ──

// One row per source, search config, and scope (a keyword for sources queried per keyword, a
// board token for employer boards, '' for one-feed sources). last_pulled_at is the watermark: the
// start time of the last pull of that scope that finished completely. A failed or cut-short pull
// records the attempt and leaves the watermark alone. Times are ISO strings with a Z.
export const sourcePulls = sqliteTable('source_pulls', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  source: text('source').notNull(),
  configId: integer('config_id').notNull(),
  scope: text('scope').notNull().default(''),
  /** Hash of the config's filters when the watermark was set. A different hash means a full pull. */
  filterHash: text('filter_hash'),
  lastPulledAt: text('last_pulled_at'),
  lastAttemptAt: text('last_attempt_at'),
  lastStatus: text('last_status'), // ok, partial, failed, unavailable
  lastError: text('last_error'),
  lastMode: text('last_mode'), // full, incremental
  found: integer('found').notNull().default(0),
  passed: integer('passed').notNull().default(0),
  known: integer('known').notNull().default(0),
  added: integer('added').notNull().default(0),
  requests: integer('requests').notNull().default(0),
  updatedAt: text('updated_at').notNull(),
}, table => [
  uniqueIndex('source_pulls_key_idx').on(table.source, table.configId, table.scope),
])

/** Employer boards found through apply links, pulled like the curated list in job-sources/ats-boards.ts. */
export const jobBoards = sqliteTable('job_boards', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ats: text('ats').notNull(),
  token: text('token').notNull(),
  company: text('company').notNull(),
  foundVia: text('found_via'),
  status: text('status').notNull().default('active'), // active, gone
  lastError: text('last_error'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, table => [
  uniqueIndex('job_boards_ats_token_idx').on(table.ats, table.token),
  index('job_boards_status_idx').on(table.status),
])

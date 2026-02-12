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
}, (table) => [
  index('jobs_source_source_id_idx').on(table.source, table.sourceId),
  index('jobs_status_idx').on(table.status),
  index('jobs_match_score_idx').on(table.matchScore),
  index('jobs_company_idx').on(table.company),
])

export const applications = sqliteTable('applications', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  jobId: integer('job_id').notNull().references(() => jobs.id),
  tailoredResumeJson: text('tailored_resume_json'), // JSON of the tailored resume
  tailoredResumePdfPath: text('tailored_resume_pdf_path'),
  coverLetter: text('cover_letter'),
  tailoringNotes: text('tailoring_notes'),
  status: text('status').notNull().default('draft'), // draft, ready, submitted, response_received, interviewing, rejected, offer
  submittedAt: text('submitted_at'),
  responseAt: text('response_at'),
  notes: text('notes'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
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
}, (table) => [
  index('questions_status_idx').on(table.status),
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

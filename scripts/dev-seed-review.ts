// Dev-only fixtures for the review dashboard. Inserts jobs and applications in every review state
// (proposed, needs_input with blocking questions, publishing, submitting, submitted, submit_failed,
// needs_manual) with the full JSON shapes from shared/types/pipeline.ts.
//
// Run from the worktree root:  npx tsx scripts/dev-seed-review.ts
//
// Safety:
// - Refuses any database outside ./data of the current directory, and refuses NODE_ENV=production.
// - Every row it writes is is_sandbox=1 and every job has source 'fixture'.
// - Re-running deletes only the rows a previous run created (source 'fixture'), then inserts fresh ones.
// - Resume lines, form answers, and the cover letter's summary and accomplishment sentences come
//   from the knowledge base rows in the same database. Each fixture's one-line cover letter "focus"
//   sentence is hand-written fixture copy, acceptable only because these rows are dev-only and
//   is_sandbox=1. Learned adjustments and their explanations are fixture data, not real history.
// - Apply links point at this app's own sandbox form, never at an employer.

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type {
  CompensationBreakdown,
  DemoFile,
  FormAnswer,
  FormField,
  FormSnapshot,
  GapAnalysis,
  Requirement,
  ScoreBreakdown,
  SubmissionResult,
  TailoredResume,
} from '../shared/types/pipeline'

// ── Guard rails ──────────────────────────────────────────────

function readEnvFile(): Record<string, string> {
  const out: Record<string, string> = {}
  if (!existsSync('.env')) return out
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) out[m[1]!] = m[2]!.replace(/^['"]|['"]$/g, '')
  }
  return out
}

const env = { ...readEnvFile(), ...process.env } as Record<string, string | undefined>
const dbPath = resolve(env.NUXT_DATABASE_PATH || './data/job-hunter.db')
const allowedDir = resolve('./data') + sep

if (env.NODE_ENV === 'production') {
  console.error('Refusing to seed: NODE_ENV is production.')
  process.exit(1)
}
if (!dbPath.startsWith(allowedDir)) {
  console.error(`Refusing to seed ${dbPath}: fixtures only go into ${allowedDir}`)
  process.exit(1)
}
if ((env.NUXT_PUBLIC_BASE_URL || '').includes('devinsmini.com')) {
  console.error('Refusing to seed: NUXT_PUBLIC_BASE_URL points at production.')
  process.exit(1)
}

const port = env.NUXT_PORT || env.PORT || '3000'
const sandboxToken = env.NUXT_SANDBOX_TOKEN || ''
const localBase = `http://localhost:${port}`
const sandboxApplyUrl = sandboxToken ? `${localBase}/sandbox/apply/${sandboxToken}` : `${localBase}/sandbox/apply/unset`
const dataDir = dirname(dbPath)

mkdirSync(dataDir, { recursive: true })
const sqlite = new Database(dbPath)
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('foreign_keys = ON')
migrate(drizzle(sqlite), { migrationsFolder: './server/db/migrations' })

// ── Helpers ──────────────────────────────────────────────────

function sqlTime(offsetMinutes = 0): string {
  return new Date(Date.now() + offsetMinutes * 60_000).toISOString().replace('T', ' ').slice(0, 19)
}
function isoTime(offsetMinutes = 0): string {
  return new Date(Date.now() + offsetMinutes * 60_000).toISOString()
}
function stripHtml(html: string | null): string {
  if (!html) return ''
  return html
    .replace(/<(br|\/p|\/li|\/h\d|\/div)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&rsquo;|&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
}
/** Exact sentence from the posting containing the needle, or null when the posting does not say it. */
function quoteFrom(text: string, needle: string): string | null {
  const i = text.toLowerCase().indexOf(needle.toLowerCase())
  if (i < 0) return null
  const start = Math.max(text.lastIndexOf('\n', i) + 1, text.lastIndexOf('. ', i) >= 0 ? text.lastIndexOf('. ', i) + 2 : 0)
  const ends = [text.indexOf('\n', i), text.indexOf('. ', i)].filter(n => n >= 0).map((n, k) => (k === 1 ? n + 1 : n))
  const end = ends.length ? Math.min(...ends) : text.length
  return text.slice(start, end).trim().replace(/^- /, '')
}

// ── Knowledge base (deduped like loadKnowledge) ──────────────

interface KbRow { id: number; category: string; key: string; value: string; updated_at: string }
const kbRows = sqlite.prepare('select id, category, key, value, updated_at from knowledge_entries').all() as KbRow[]
const kb = new Map<string, KbRow>()
for (const r of kbRows) {
  const k = `${r.category}\u0000${r.key.trim().toLowerCase()}`
  const prev = kb.get(k)
  if (!prev || r.updated_at > prev.updated_at || (r.updated_at === prev.updated_at && r.id > prev.id)) kb.set(k, r)
}
const kbList = [...kb.values()].sort((a, b) => a.id - b.id)
function kbValue(category: string, key: string): string | null {
  return kb.get(`${category}\u0000${key.toLowerCase()}`)?.value ?? null
}
if (kbList.length === 0) {
  console.error('The knowledge base is empty. Copy the production snapshot into data/job-hunter.db first.')
  process.exit(1)
}

const fullName = kbValue('profile', 'Full Name') || 'Candidate'
const [firstName, ...rest] = fullName.split(' ')
const lastName = rest.join(' ')
const email = kbValue('profile', 'Email')
const phone = kbValue('profile', 'Phone')
const github = kbValue('profile', 'GitHub')
const summary = kbValue('profile', 'Professional Summary') || ''
const targetSalary = kbValue('preference', 'Target Salary') || ''
const floor = Number((targetSalary.match(/\$([\d,]+)/)?.[1] || '0').replace(/,/g, '')) || null

/** Experience entries parsed from the knowledge base text: "period | location", then "- " bullets. */
const experience = kbList.filter(r => r.category === 'experience').map((r) => {
  const [company, title] = r.key.split(' - ').map(s => s.trim())
  const lines = r.value.split('\n')
  const period = (lines[0] || '').split('|')[0]!.trim()
  const accomplishments: string[] = []
  let section = ''
  for (const line of lines.slice(1)) {
    if (/^accomplishments:/i.test(line)) section = 'a'
    else if (/^responsibilities:/i.test(line)) section = 'r'
    else if (line.startsWith('- ') && section === 'a') accomplishments.push(line.slice(2).trim())
  }
  return { company: company || r.key, title: title || '', period, bullets: accomplishments }
})

const skillsByGroup: Record<string, string[]> = {
  'Backend': ['PHP', 'Laravel', 'CakePHP', 'Node.js', 'Express', 'AdonisJS'],
  'Frontend': ['Vue.js', 'TypeScript', 'JavaScript', 'CSS/SASS/LESS', 'Webpack'],
  'Mobile': ['CapacitorJS', 'Flutter'],
  'Data': ['MySQL', 'Redis', 'Elasticsearch', 'MongoDB', 'Kafka', 'Clickhouse'],
  'Infrastructure': ['AWS', 'DigitalOcean', 'Kubernetes', 'GitHub Actions', 'Sentry'],
  'Testing and process': ['PHPUnit', 'Jest', 'SCRUM/Agile'],
}
// Keep only skills that really are in the knowledge base.
for (const group of Object.keys(skillsByGroup)) {
  skillsByGroup[group] = skillsByGroup[group]!.filter(s => kbValue('skill', s) !== null)
  if (skillsByGroup[group]!.length === 0) delete skillsByGroup[group]
}

const education = kbList.filter(r => r.category === 'education').map(r => ({
  institution: r.key,
  degree: r.value.split('|')[0]!.trim(),
  year: '',
}))

const projects = kbList.filter(r => r.category === 'project').map(r => ({
  name: r.key,
  description: r.value.split('\n')[0]!.trim(),
  url: null,
}))

function resumeFor(order: string[], notes: string, extraProjects: TailoredResume['projects'] = []): TailoredResume {
  const exp = [...experience]
  return {
    summary,
    experience: exp.map(e => ({
      ...e,
      // Reorder bullets so the ones that match the posting lead. Wording is the knowledge base's own.
      bullets: [...e.bullets].sort((a, b) => score(b) - score(a)),
    })),
    skills: skillsByGroup,
    education,
    projects: [...projects, ...(extraProjects || [])],
    tailoringNotes: notes,
    generatedQuestions: [],
  }
  function score(bullet: string) {
    return order.reduce((n, word) => n + (bullet.toLowerCase().includes(word.toLowerCase()) ? 1 : 0), 0)
  }
}

function coverLetterFor(company: string, role: string, focus: string): string {
  const applied = experience.find(e => /applied imagination/i.test(e.company))
  const sentry = applied?.bullets.find(b => /sentry/i.test(b))
  const k8s = applied?.bullets.find(b => /kubernetes/i.test(b))
  return [
    `Dear ${company} hiring team,`,
    '',
    `I am applying for the ${role} role. ${summary}`,
    '',
    `At ${applied?.company ?? 'Applied Imagination'} I work as ${applied?.title ?? 'a senior developer'}. ${focus}`,
    sentry ? `I ${sentry.charAt(0).toLowerCase()}${sentry.slice(1)}` : '',
    k8s ? `I also ${k8s.charAt(0).toLowerCase()}${k8s.slice(1)}` : '',
    '',
    `I would welcome a conversation about the role.`,
    '',
    `${fullName}`,
    [email, phone].filter(Boolean).join(' | '),
  ].filter((line, i, all) => !(line === '' && all[i - 1] === '')).join('\n')
}

// ── Form snapshot and answers ────────────────────────────────

interface FieldSpec extends FormField { answer: Omit<FormAnswer, 'fieldId' | 'label'> }

function baseFields(coverLetter: string): FieldSpec[] {
  const kbAnswer = (key: string, value: string | null) => value
    ? { value, source: 'knowledge' as const, sourceDetail: `profile:${key}`, confidence: 'high' as const, filled: true }
    : { value: null, source: 'skipped' as const, sourceDetail: `No ${key} in the knowledge base`, confidence: 'low' as const, filled: false }
  return [
    { id: 'first_name', selector: '#first_name', label: 'First name', type: 'text', required: true, answer: kbAnswer('Full Name', firstName || null) },
    { id: 'last_name', selector: '#last_name', label: 'Last name', type: 'text', required: true, answer: kbAnswer('Full Name', lastName || null) },
    { id: 'email', selector: '#email', label: 'Email', type: 'email', required: true, answer: kbAnswer('Email', email) },
    { id: 'phone', selector: '#phone', label: 'Phone', type: 'tel', required: true, answer: kbAnswer('Phone', phone) },
    { id: 'linkedin', selector: '#linkedin', label: 'LinkedIn profile', type: 'url', required: false, answer: kbAnswer('LinkedIn', kbValue('profile', 'LinkedIn')) },
    { id: 'github', selector: '#github', label: 'GitHub or portfolio URL', type: 'url', required: false, answer: kbAnswer('GitHub', github ? `https://github.com/${github}` : null) },
    { id: 'resume', selector: '#resume', label: 'Resume', type: 'file', required: true, answer: { value: 'Tailored resume PDF (attached only at submit)', source: 'resume', sourceDetail: 'tailored_resume_pdf', confidence: 'high', filled: false } },
    { id: 'cover_letter', selector: '#cover_letter', label: 'Cover letter', type: 'textarea', required: false, answer: { value: coverLetter, source: 'cover_letter', sourceDetail: 'application.cover_letter', confidence: 'high', filled: true } },
    { id: 'salary', selector: '#salary', label: 'Desired annual salary (USD)', type: 'text', required: false, answer: { value: targetSalary || null, source: targetSalary ? 'knowledge' : 'skipped', sourceDetail: 'preference:Target Salary', confidence: targetSalary ? 'medium' : 'low', filled: !!targetSalary } },
    { id: 'heard', selector: '#heard', label: 'How did you hear about this job?', type: 'select', required: false, options: ['Job board', 'Referral', 'Company website', 'Other'], answer: { value: 'Job board', source: 'generated', sourceDetail: 'Listing source: Remotive', confidence: 'medium', filled: true } },
    { id: 'gender', selector: '#gender', label: 'Gender', type: 'select', required: false, isEeo: true, section: 'Voluntary self-identification', options: ['Male', 'Female', 'Non-binary', 'Decline to self-identify'], answer: { value: 'Decline to self-identify', source: 'eeo_decline', sourceDetail: 'EEO answers are never inferred', confidence: 'high', filled: true } },
    { id: 'veteran', selector: '#veteran', label: 'Veteran status', type: 'select', required: false, isEeo: true, section: 'Voluntary self-identification', options: ['I am a protected veteran', 'I am not a protected veteran', 'I do not wish to answer'], answer: { value: 'I do not wish to answer', source: 'eeo_decline', sourceDetail: 'EEO answers are never inferred', confidence: 'high', filled: true } },
  ]
}

function formFor(fields: FieldSpec[], title: string, atsType: FormSnapshot['atsType'], applyUrl: string, opts: { requiresAccount?: boolean; blockers?: string[] } = {}) {
  const snapshot: FormSnapshot = {
    url: applyUrl,
    finalUrl: applyUrl,
    atsType,
    title,
    fields: fields.map(({ answer: _a, ...f }) => f),
    capturedAt: isoTime(-180),
    requiresAccount: opts.requiresAccount ?? false,
    blockers: opts.blockers ?? [],
  }
  const answers: FormAnswer[] = fields.map(f => ({ fieldId: f.id, label: f.label, ...f.answer }))
  return { snapshot, answers }
}

// ── Screenshots of the filled form (rendered locally, no network) ───

async function renderScreenshots(jobs: Array<{ file: string; html: string }>) {
  if (jobs.length === 0) return 0
  let chromium: typeof import('playwright').chromium
  try {
    ({ chromium } = await import('playwright'))
  }
  catch {
    console.warn('Playwright is not available, so fixtures have no screenshots.')
    return 0
  }
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 1 })
    for (const j of jobs) {
      await page.setContent(j.html, { waitUntil: 'load' })
      mkdirSync(dirname(j.file), { recursive: true })
      await page.screenshot({ path: j.file, fullPage: true })
    }
  }
  finally {
    await browser.close()
  }
  return jobs.length
}

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function formHtml(company: string, role: string, answers: FormAnswer[]): string {
  const rows = answers.map((a) => {
    const v = Array.isArray(a.value) ? a.value.join(', ') : a.value === null ? '' : String(a.value)
    const input = a.label === 'Cover letter'
      ? `<textarea rows="5">${esc(v)}</textarea>`
      : a.label === 'Resume'
        ? `<div class="file">No file chosen <span>(the resume is attached only at submit)</span></div>`
        : `<input value="${esc(v)}" class="${a.filled ? '' : 'empty'}">`
    return `<label><span>${esc(a.label)}</span>${input}</label>`
  }).join('')
  return `<!doctype html><html><head><style>
    body{margin:0;font:15px/1.45 -apple-system,'Segoe UI',sans-serif;color:#1d2733;background:#fff}
    header{background:#1d2733;color:#fff;padding:24px 32px} header h1{margin:0 0 4px;font-size:22px} header p{margin:0;opacity:.75}
    form{padding:24px 32px;display:grid;gap:14px;max-width:760px}
    label{display:grid;gap:4px} label span{font-weight:600;font-size:13px}
    input,textarea{border:1px solid #b9c2cc;border-radius:4px;padding:8px 10px;font:inherit;background:#fff}
    input.empty{background:#fff5f5;border-color:#e2a3a3}
    .file{border:1px dashed #b9c2cc;border-radius:4px;padding:8px 10px;color:#5b6772} .file span{font-size:12px}
    .note{background:#eef4fb;border:1px solid #c8d9ee;padding:10px 12px;border-radius:4px;font-size:13px}
  </style></head><body>
    <header><h1>${esc(role)}</h1><p>${esc(company)}: application form, filled and not submitted</p></header>
    <form><div class="note">Dry run by job-hunter. Nothing on this page has been sent.</div>${rows}</form>
  </body></html>`
}

function confirmationHtml(company: string, role: string, when: string): string {
  return `<!doctype html><html><head><style>
    body{margin:0;font:15px/1.5 -apple-system,'Segoe UI',sans-serif;color:#1d2733;background:#fff;padding:40px}
    .box{max-width:620px;border:1px solid #c8e6c9;border-radius:6px;padding:24px}
    h1{font-size:22px;margin:0 0 8px;color:#1b5e20}
  </style></head><body><div class="box"><h1>Application received</h1>
    <p>Thanks for applying to ${esc(role)} at ${esc(company)}. We received your application on ${esc(when)}.</p>
    <p>Confirmation number: SBX-${Math.floor(100000 + Math.random() * 899999)}</p></div></body></html>`
}

// ── Remove the previous run's fixtures ──────────────────────

const oldJobIds = (sqlite.prepare(`select id from jobs where source = 'fixture' and is_sandbox = 1`).all() as Array<{ id: number }>).map(r => r.id)
if (oldJobIds.length) {
  const marks = oldJobIds.map(() => '?').join(',')
  const oldAppIds = (sqlite.prepare(`select id from applications where job_id in (${marks})`).all(...oldJobIds) as Array<{ id: number }>).map(r => r.id)
  const appMarks = oldAppIds.map(() => '?').join(',') || 'null'
  sqlite.transaction(() => {
    sqlite.prepare(`delete from questions where job_id in (${marks}) or application_id in (${appMarks})`).run(...oldJobIds, ...oldAppIds)
    sqlite.prepare(`delete from demo_projects where job_id in (${marks})`).run(...oldJobIds)
    sqlite.prepare(`delete from decisions where job_id in (${marks})`).run(...oldJobIds)
    sqlite.prepare(`delete from score_history where job_id in (${marks})`).run(...oldJobIds)
    sqlite.prepare(`delete from applications where job_id in (${marks})`).run(...oldJobIds)
    sqlite.prepare(`delete from jobs where id in (${marks})`).run(...oldJobIds)
  })()
  console.log(`Removed ${oldJobIds.length} fixture jobs from the previous run.`)
}
sqlite.prepare(`delete from pipeline_runs where host = 'dev-seed-review'`).run()
sqlite.prepare(`delete from ai_calls where purpose = 'dev-seed-review'`).run()

// ── Fixture definitions ──────────────────────────────────────

interface SourceJob { id: number; title: string; company: string; location: string | null; remote_type: string | null; salary_min: number | null; salary_max: number | null; salary_currency: string | null; description: string | null; url: string | null; tags: string | null }
function sourceJob(title: string, company: string): SourceJob {
  const row = sqlite.prepare(`select * from jobs where title = ? and company = ? and source != 'fixture' order by id limit 1`).get(title, company) as SourceJob | undefined
  if (!row) throw new Error(`Snapshot job not found: ${title} at ${company}. Copy the production snapshot first.`)
  return row
}

interface Fixture {
  key: string
  src: SourceJob
  status: string
  statusDetail: string | null
  proposedMinutesAgo: number
  score: ScoreBreakdown
  comp: CompensationBreakdown
  requirements: Requirement[]
  focus: string
  resumeOrder: string[]
  gap: GapAnalysis | null
  demo?: {
    slug: string; title: string; summary: string; gap: string; stack: string[]; status: string
    files: DemoFile[]; readme: string; testCommand: string; testOutput: string; testsPassed: boolean | null; error?: string | null
  }
  questions?: Array<{ question: string; context: string; kind: string; subject: string; answerType: 'yes_no' | 'text' | 'number' | 'choice'; choices?: string[]; blocking: boolean; fieldId?: string }>
  atsType: FormSnapshot['atsType']
  applyUrl?: string
  requiresAccount?: boolean
  blockers?: string[]
  submission?: Omit<SubmissionResult, 'screenshotPath'> & { screenshot: boolean }
  submitError?: string | null
  submitAttempts?: number
  decidedMinutesAgo?: number
}

function breakdown(opts: {
  skills: number; skillsReason: string; matched: string[]; missing: string[]
  comp: number | null; compReason: string; estimate: number | null
  learned: Array<{ label: string; points: number; detail: string; ruleId?: number }>
}): ScoreBreakdown {
  const weights = { skills: 0.65, compensation: 0.35 }
  const compScore = opts.comp ?? opts.skills
  const learnedTotal = opts.learned.reduce((n, c) => n + c.points, 0)
  const final = Math.max(0, Math.min(100, Math.round(opts.skills * weights.skills + compScore * weights.compensation) + learnedTotal))
  return {
    final,
    skills: { score: opts.skills, reasoning: opts.skillsReason, matched: opts.matched, missing: opts.missing },
    compensation: {
      score: opts.comp,
      reasoning: opts.compReason,
      floor,
      estimate: opts.estimate,
      meetsFloor: opts.estimate === null || floor === null ? null : opts.estimate >= floor,
    },
    learned: { total: learnedTotal, components: opts.learned },
    weights,
    recommendation: final >= 82 ? 'strong_match' : final >= 70 ? 'good_match' : final >= 55 ? 'partial_match' : 'weak_match',
    computedAt: isoTime(-240),
  }
}

function req(text: string, kind: Requirement['kind'], mustHave: boolean, status: Requirement['status'], evidenceKey: string | null): Requirement {
  return { text, kind, mustHave, status, evidence: evidenceKey && kbValue(evidenceKey.split(':')[0]!, evidenceKey.split(':')[1]!) !== null ? evidenceKey : null }
}

function notStatedComp(notes: string, extra: Partial<CompensationBreakdown> = {}): CompensationBreakdown {
  return {
    currency: 'USD', baseMin: null, baseMax: null, basePeriod: null, baseAnnualMin: null, baseAnnualMax: null,
    bonus: null, equity: null, benefits: [], totalEstimateMin: null, totalEstimateMax: null,
    confidence: 'not_stated', notes, extractedAt: isoTime(-300), ...extra,
  }
}

const bnsf = sourceJob('Product, Platform & Enterprise Full Stack Sr/Staff Software Engineer', 'BNSF Railway')
const bnsfText = stripHtml(bnsf.description)
const chooose = sourceJob('Fullstack Developer (US - ET)', 'Chooose')
const choooseText = stripHtml(chooose.description)
const clipster = sourceJob('Senior Product Engineer (Fullstack)', 'Clipster')
const golang = sourceJob('Senior Golang Developer', 'Lemon.io')
const golangText = stripHtml(golang.description)
const easybill = (sqlite.prepare(`select * from jobs where company = 'easybill GmbH' and source != 'fixture' order by id limit 1`).get()) as SourceJob
const reactFs = sourceJob('Senior React Full-stack Developer', 'Lemon.io')
const reactText = stripHtml(reactFs.description)
const backend = sourceJob('Senior back-end Engineer', 'Lemon.io')
const headEng = sourceJob('Head of Engineering', 'Lemon.io')
const devops = sourceJob('Senior DevOps Engineer', 'Lemon.io')

const lemonRateQuote = quoteFrom(reactText, 'The rate depends on your seniority') ?? 'The rate depends on your seniority level, skills and experience.'
const lemonNoBenefits = quoteFrom(reactText, 'does not include the benefits') ?? null

function benefit(name: string, category: CompensationBreakdown['benefits'][number]['category'], detail: string, text: string, needle: string, value: number | null = null) {
  const quote = quoteFrom(text, needle)
  return quote ? [{ name, category, detail, estimatedAnnualValue: value, quote }] : []
}

const fixtures: Fixture[] = [
  {
    key: 'bnsf',
    src: bnsf,
    status: 'proposed',
    statusDetail: 'Ready for review',
    proposedMinutesAgo: 95,
    score: breakdown({
      skills: 88,
      skillsReason: 'Full-stack TypeScript and Node.js with Vue on the front end, CI/CD in GitHub Actions, and AWS. Every must-have maps to a knowledge base skill.',
      matched: ['TypeScript', 'Node.js', 'Vue.js', 'AWS', 'GitHub Actions', 'MySQL'],
      missing: ['Java'],
      comp: 92,
      compReason: 'Stated base of $165,000 to $300,000 starts above your $150,000 floor before bonus and benefits.',
      estimate: 252000,
      learned: [
        { label: 'Fully remote, US', points: 3, detail: 'You approved 4 of the last 5 fully remote US roles.', ruleId: 1 },
        { label: 'Large enterprise', points: -2, detail: 'You rejected 2 enterprise roles for "Too senior or pure management".', ruleId: 4 },
      ],
    }),
    comp: {
      currency: 'USD',
      baseMin: bnsf.salary_min, baseMax: bnsf.salary_max, basePeriod: 'year',
      baseAnnualMin: bnsf.salary_min, baseAnnualMax: bnsf.salary_max,
      bonus: quoteFrom(bnsfText, 'Annual bonus') ? { description: 'Annual bonus (Incentive Compensation Program), target not stated', estimatedAnnual: null, quote: quoteFrom(bnsfText, 'Annual bonus')! } : null,
      equity: null,
      benefits: [
        ...benefit('401(k) and Railroad Retirement', 'retirement', 'Match amount not stated', bnsfText, '401(k)'),
        ...benefit('Medical, dental, vision', 'health', 'Plan options for you and dependents', bnsfText, 'robust health care'),
        ...benefit('HSA with employer contribution, life and disability', 'insurance', 'Life and disability at no cost', bnsfText, 'Health care spending accounts'),
        ...benefit('Family building and parental support', 'parental', 'Parental, adoption, surrogacy, dependent care match', bnsfText, 'Family benefits'),
      ],
      totalEstimateMin: 178000,
      totalEstimateMax: 326000,
      confidence: 'stated',
      notes: 'Bonus target and 401(k) match are not stated, so they are not counted. Benefits valued at the posting\'s stated figures only.',
      extractedAt: isoTime(-300),
    },
    requirements: [
      req('Full-stack engineering with TypeScript and Node.js', 'language', true, 'have', 'skill:TypeScript'),
      req('Modern front-end framework (React, Vue, or Angular)', 'framework', true, 'have', 'skill:Vue.js'),
      req('CI/CD pipelines', 'skill', true, 'have', 'skill:GitHub Actions'),
      req('Cloud infrastructure on AWS', 'skill', false, 'have', 'skill:AWS'),
      req('Java services', 'language', false, 'lack', null),
    ],
    focus: 'I build and run full-stack TypeScript, Node.js, and Vue applications, and I set up the CI/CD that ships them.',
    resumeOrder: ['GitHub Actions', 'Kubernetes', 'Node.js', 'Vue', 'Sentry'],
    gap: {
      items: [{ requirement: 'Java services', mustHave: false, decision: 'skip', rationale: 'Nice to have only, and the role is TypeScript first.' }],
      demoRecommended: false,
      summary: 'No gap worth a demo. Java is optional.',
      analyzedAt: isoTime(-200),
    },
    questions: [
      { question: 'Have you worked on software for railroads or freight logistics?', context: 'BNSF lists rail domain knowledge as a plus. Your knowledge base mentions transportation and logistics but not rail.', kind: 'has_done', subject: 'rail logistics software', answerType: 'yes_no', blocking: false },
    ],
    atsType: 'sandbox',
  },
  {
    key: 'clipster',
    src: clipster,
    status: 'needs_input',
    statusDetail: 'Waiting on 2 answers before it can be approved',
    proposedMinutesAgo: 80,
    score: breakdown({
      skills: 84,
      skillsReason: 'Product-minded full-stack role. Your Vue, Node.js, and Laravel work matches. Payments experience is the gap.',
      matched: ['Vue.js', 'Node.js', 'TypeScript', 'MySQL', 'Redis'],
      missing: ['Payment systems'],
      comp: null,
      compReason: 'The posting gives no salary. Scored on skills only.',
      estimate: null,
      learned: [
        { label: 'Async, remote first', points: 2, detail: 'You approved 3 async-first teams.', ruleId: 2 },
        { label: 'Europe time zone', points: -1, detail: 'One rejection for "Location or time zone" on a UTC+2 role.', ruleId: 6 },
      ],
    }),
    comp: notStatedComp('No salary, bonus, or benefits stated.'),
    requirements: [
      req('Full-stack product engineering', 'experience', true, 'have', 'skill:Vue.js'),
      req('TypeScript', 'language', true, 'have', 'skill:TypeScript'),
      req('Payment systems (around $1M in monthly payouts)', 'domain', false, 'lack', null),
      req('Available during core hours 10am to 2pm UTC+2', 'other', true, 'unknown', null),
    ],
    focus: 'I own features end to end, from the schema to the Vue front end, and I care how the product feels to the people using it.',
    resumeOrder: ['Vue', 'Node.js', 'Redis', 'redesign'],
    gap: {
      items: [
        {
          requirement: 'Payment systems', mustHave: false, decision: 'demo',
          rationale: 'Clipster pays out creators. A small payout ledger shows the idea without claiming production payments work.',
          demoIdea: { title: 'Creator payout ledger', summary: 'Double-entry ledger that batches creator payouts and reconciles them against a mock provider.', stack: ['TypeScript', 'Node.js', 'SQLite'], scopeHours: 3 },
        },
        { requirement: 'Core hours 10am to 2pm UTC+2', mustHave: true, decision: 'ask', rationale: 'Only you know whether those hours work.' },
      ],
      demoRecommended: true,
      summary: 'One demo for payouts, one question about hours.',
      analyzedAt: isoTime(-200),
    },
    demo: {
      slug: 'creator-payout-ledger',
      title: 'Creator payout ledger',
      summary: 'A double-entry ledger in TypeScript that batches creator payouts, posts them to a mock payment provider, and reconciles the provider\'s webhook events.',
      gap: 'Payment systems (around $1M in monthly payouts)',
      stack: ['TypeScript', 'Node.js', 'SQLite', 'Vitest'],
      status: 'built',
      files: [
        { path: 'README.md', bytes: 2140 },
        { path: 'src/ledger.ts', bytes: 4810 },
        { path: 'src/payouts.ts', bytes: 3322 },
        { path: 'src/provider/mock.ts', bytes: 1876 },
        { path: 'src/reconcile.ts', bytes: 2954 },
        { path: 'test/ledger.test.ts', bytes: 3410 },
        { path: 'test/reconcile.test.ts', bytes: 2702 },
        { path: 'package.json', bytes: 612 },
      ],
      readme: '# Creator payout ledger\n\nA small double-entry ledger for paying out creators.\n\n## What it does\n\n- Records every payout as balanced debit and credit entries.\n- Batches pending payouts per creator and sends them to a mock provider.\n- Reconciles provider webhook events and flags mismatches.\n\n## Run it\n\n```\nnpm install\nnpm test\n```\n\nBuilt as a demo. It talks to a mock provider only.',
      testCommand: 'npm test',
      testOutput: ' RUN  v2.1.8\n\n ✓ test/ledger.test.ts (9 tests) 41ms\n ✓ test/reconcile.test.ts (6 tests) 33ms\n\n Test Files  2 passed (2)\n      Tests  15 passed (15)\n   Duration  612ms',
      testsPassed: true,
    },
    questions: [
      { question: 'Can you be available 10am to 2pm UTC+2 (3am to 7am Central) on weekdays?', context: 'The posting asks for availability during core hours, 10am to 2pm UTC+2. Your knowledge base has no answer about working hours.', kind: 'preference', subject: 'core hours utc+2', answerType: 'yes_no', blocking: true, fieldId: 'core_hours' },
      { question: 'What is the earliest date you could start?', context: 'The form has a required start date field and your knowledge base has no answer.', kind: 'form_field', subject: 'earliest start date', answerType: 'text', blocking: true, fieldId: 'start_date' },
    ],
    atsType: 'sandbox',
  },
  {
    key: 'chooose',
    src: chooose,
    status: 'proposed',
    statusDetail: 'Ready for review',
    proposedMinutesAgo: 70,
    score: breakdown({
      skills: 79,
      skillsReason: 'Full-stack web with client-facing work. Your consulting work with clients at Applied Imagination fits the "external facing clients" bonus.',
      matched: ['TypeScript', 'Node.js', 'Vue.js', 'AWS'],
      missing: ['React'],
      comp: 70,
      compReason: 'Salary not stated. Equity and a full benefits package are stated, so the estimate is partial.',
      estimate: null,
      learned: [
        { label: 'Must live in MA, NY, PA, MD, or FL', points: -5, detail: 'You rejected 3 roles restricted to states you do not live in.', ruleId: 7 },
        { label: 'Climate tech', points: 2, detail: 'You approved 2 of 2 climate roles.', ruleId: 9 },
      ],
    }),
    comp: {
      currency: 'USD', baseMin: null, baseMax: null, basePeriod: null, baseAnnualMin: null, baseAnnualMax: null,
      bonus: null,
      equity: quoteFrom(choooseText, 'both salary and equity') ? { description: 'Equity in Chooose, amount not stated', estimatedAnnual: null, quote: quoteFrom(choooseText, 'both salary and equity')! } : null,
      benefits: [
        ...benefit('Medical, dental, vision', 'health', 'Coverage share not stated', choooseText, 'medical, dental, and vision'),
      ],
      totalEstimateMin: null, totalEstimateMax: null,
      confidence: 'partial',
      notes: 'No salary figure, so no total. Benefits listed in one sentence of the posting.',
      extractedAt: isoTime(-300),
    },
    requirements: [
      req('Full-stack web development', 'experience', true, 'have', 'skill:JavaScript'),
      req('React', 'framework', true, 'partial', 'skill:Vue.js'),
      req('Managing external facing clients', 'experience', false, 'have', null),
      req('Based in MA, NY, PA, MD, or FL', 'other', true, 'unknown', null),
    ],
    focus: 'I have built full-stack products for clients and worked directly with them on scope and delivery.',
    resumeOrder: ['contracts', 'Vue', 'Node.js', 'GitHub Actions'],
    gap: {
      items: [{ requirement: 'React', mustHave: true, decision: 'reframe', rationale: 'Vue 3 Composition API experience maps closely. The resume leads with component architecture.' }],
      demoRecommended: false,
      summary: 'React is reframed through Vue. No demo.',
      analyzedAt: isoTime(-200),
    },
    atsType: 'sandbox',
  },
  {
    key: 'golang',
    src: golang,
    status: 'proposed',
    statusDetail: 'Ready for review',
    proposedMinutesAgo: 60,
    score: breakdown({
      skills: 62,
      skillsReason: 'Senior backend fit, but Go is the core language and the knowledge base has no Go.',
      matched: ['Node.js', 'Kubernetes', 'Kafka', 'Redis'],
      missing: ['Go', 'Python'],
      comp: null,
      compReason: 'Contract rate set per engineer. The posting states no figure.',
      estimate: null,
      learned: [
        { label: 'Marketplace contract first', points: -6, detail: 'You rejected 4 Lemon.io listings for "Not this company".', ruleId: 3 },
      ],
    }),
    comp: notStatedComp('Contract work through a marketplace before any direct hire.', {
      benefits: [],
      equity: quoteFrom(golangText, 'with equity') ? { description: 'Equity only after a direct hire', estimatedAnnual: null, quote: quoteFrom(golangText, 'with equity')! } : null,
    }),
    requirements: [
      req('Go in production', 'language', true, 'lack', null),
      req('Distributed systems', 'experience', true, 'partial', 'skill:Kafka'),
      req('4+ years commercial development', 'experience', true, 'have', 'profile:Years of Experience'),
    ],
    focus: 'I have moved a PHP monolith to Node.js microservices and processed billion-record datasets with Kafka.',
    resumeOrder: ['microservice', 'Kafka', 'billion', 'Kubernetes'],
    gap: {
      items: [{
        requirement: 'Go in production', mustHave: true, decision: 'demo', rationale: 'A small Go service shows working knowledge without claiming production use.',
        demoIdea: { title: 'Webhook ingester in Go', summary: 'Go service that verifies, queues, and retries payment webhooks.', stack: ['Go', 'SQLite'], scopeHours: 3 },
      }],
      demoRecommended: true,
      summary: 'Go demo attempted.',
      analyzedAt: isoTime(-200),
    },
    demo: {
      slug: 'go-webhook-ingester',
      title: 'Webhook ingester in Go',
      summary: 'A Go HTTP service that verifies webhook signatures, stores events, and retries delivery with backoff.',
      gap: 'Go in production',
      stack: ['Go', 'SQLite'],
      status: 'failed',
      files: [
        { path: 'README.md', bytes: 1480 },
        { path: 'main.go', bytes: 2210 },
        { path: 'ingest/handler.go', bytes: 3104 },
        { path: 'ingest/handler_test.go', bytes: 2388 },
        { path: 'go.mod', bytes: 120 },
      ],
      readme: '# Webhook ingester\n\nVerifies HMAC signatures, stores events in SQLite, and retries failed deliveries.',
      testCommand: 'go test ./...',
      testOutput: '--- FAIL: TestRetryBackoff (0.21s)\n    handler_test.go:58: expected 3 attempts, got 2\nFAIL\nFAIL\tgo-webhook-ingester/ingest\t0.412s\nFAIL',
      testsPassed: false,
      error: 'Tests failed after 2 repair attempts. It stays local and is never published in this state.',
    },
    atsType: 'sandbox',
  },
  {
    key: 'devops',
    src: devops,
    status: 'publishing',
    statusDetail: 'Publishing demo project "Kubernetes cost report"',
    proposedMinutesAgo: 600,
    decidedMinutesAgo: 1,
    score: breakdown({
      skills: 66, skillsReason: 'Kubernetes, AWS, and CI/CD match; Terraform is missing.',
      matched: ['Kubernetes', 'AWS', 'GitHub Actions'], missing: ['Terraform'],
      comp: null, compReason: 'Contract rate, no figure.', estimate: null,
      learned: [{ label: 'Marketplace contract first', points: -6, detail: 'You rejected 4 Lemon.io listings for "Not this company".', ruleId: 3 }],
    }),
    comp: notStatedComp('Contract rate set per engineer.'),
    requirements: [req('Kubernetes', 'skill', true, 'have', 'skill:Kubernetes'), req('Terraform', 'skill', true, 'lack', null)],
    focus: 'I migrated our development servers to Kubernetes and set up the CI/CD the team uses.',
    resumeOrder: ['Kubernetes', 'GitHub Actions'],
    gap: null,
    demo: {
      slug: 'k8s-cost-report', title: 'Kubernetes cost report', summary: 'CLI that reads a cluster\'s resource requests and prints a monthly cost estimate per namespace.',
      gap: 'Terraform', stack: ['TypeScript', 'Node.js'], status: 'publishing',
      files: [{ path: 'README.md', bytes: 1200 }, { path: 'src/report.ts', bytes: 3900 }, { path: 'test/report.test.ts', bytes: 2100 }],
      readme: '# Kubernetes cost report\n\nPrints a monthly cost estimate per namespace.', testCommand: 'npm test',
      testOutput: ' Test Files  1 passed (1)\n      Tests  7 passed (7)', testsPassed: true,
    },
    atsType: 'sandbox',
  },
  {
    key: 'easybill',
    src: easybill,
    status: 'submitting',
    statusDetail: 'Submitting the employer form',
    proposedMinutesAgo: 540,
    decidedMinutesAgo: 2,
    score: breakdown({
      skills: 74, skillsReason: 'PHP and TypeScript are both core here.', matched: ['PHP', 'TypeScript', 'MySQL'], missing: ['Kotlin', 'Rust'],
      comp: null, compReason: 'No salary stated.', estimate: null,
      learned: [{ label: 'German-language posting', points: -3, detail: 'You rejected 1 German-language role for "Location or time zone".', ruleId: 6 }],
    }),
    comp: notStatedComp('No salary stated.'),
    requirements: [req('PHP', 'language', true, 'have', 'skill:PHP'), req('TypeScript', 'language', true, 'have', 'skill:TypeScript')],
    focus: 'PHP and TypeScript have been my main languages for six years.',
    resumeOrder: ['PHP', 'CakePHP', 'TypeScript'],
    gap: null,
    atsType: 'sandbox',
    submitAttempts: 1,
  },
  {
    key: 'react-fs',
    src: reactFs,
    status: 'submit_failed',
    statusDetail: 'Submit failed: the confirmation page never loaded after clicking Submit (timeout 30000ms)',
    proposedMinutesAgo: 1500,
    decidedMinutesAgo: 25,
    score: breakdown({
      skills: 71, skillsReason: 'Full-stack fit; React is reframed through Vue.', matched: ['Node.js', 'TypeScript', 'PHP'], missing: ['React'],
      comp: null, compReason: 'Contract rate, no figure.', estimate: null,
      learned: [],
    }),
    comp: notStatedComp('Contract rate set per engineer.', {
      benefits: lemonNoBenefits ? [{ name: 'No benefits during the contract', category: 'other', detail: 'Benefits only after a direct hire', estimatedAnnualValue: null, quote: lemonNoBenefits }] : [],
      notes: lemonRateQuote,
    }),
    requirements: [req('React', 'framework', true, 'partial', 'skill:Vue.js'), req('Node.js', 'framework', true, 'have', 'skill:Node.js')],
    focus: 'I build full-stack applications with Node.js and a component-based front end.',
    resumeOrder: ['Node.js', 'Vue'],
    gap: null,
    atsType: 'sandbox',
    submitError: 'TimeoutError: page.waitForURL: Timeout 30000ms exceeded.\n  waiting for navigation to "**/confirmation**"\n    at submitApplication (server/utils/apply/submit.ts:88:16)',
    submitAttempts: 1,
  },
  {
    key: 'backend',
    src: backend,
    status: 'submitted',
    statusDetail: 'Submitted to the sandbox form',
    proposedMinutesAgo: 2900,
    decidedMinutesAgo: 1440,
    score: breakdown({
      skills: 76, skillsReason: 'Backend role across PHP and Node.js.', matched: ['PHP', 'Laravel', 'Node.js', 'MySQL', 'Redis'], missing: [],
      comp: null, compReason: 'Contract rate, no figure.', estimate: null, learned: [],
    }),
    comp: notStatedComp('Contract rate set per engineer.'),
    requirements: [req('Backend APIs', 'experience', true, 'have', 'skill:Laravel')],
    focus: 'I have built Laravel and Node.js APIs for SaaS products and client platforms.',
    resumeOrder: ['API', 'Laravel', 'microservice'],
    gap: null,
    atsType: 'sandbox',
    submission: { method: 'automated', submittedAt: isoTime(-1438), finalUrl: `${sandboxApplyUrl}?submitted=1`, confirmationText: 'Application received. Thanks for applying.', sandbox: true, screenshot: true },
    submitAttempts: 1,
  },
  {
    key: 'head-eng',
    src: headEng,
    status: 'needs_manual',
    statusDetail: 'Ready for you to submit by hand: Workday needs an account, and the pipeline never creates one',
    proposedMinutesAgo: 1700,
    decidedMinutesAgo: 40,
    score: breakdown({
      skills: 70, skillsReason: 'Leadership role. You have CTO and team lead experience in the knowledge base.', matched: ['SCRUM/Agile', 'AWS', 'Kubernetes'], missing: ['Hiring at scale'],
      comp: null, compReason: 'No figure stated.', estimate: null, learned: [],
    }),
    comp: notStatedComp('No salary stated.'),
    requirements: [req('Engineering leadership', 'experience', true, 'have', 'preference:Leadership Interest')],
    focus: 'I have led development teams as a CTO and as a senior developer coaching a team of seven.',
    resumeOrder: ['coached', 'Hired', 'team'],
    gap: null,
    atsType: 'workday',
    applyUrl: headEng.url ?? undefined,
    requiresAccount: true,
    blockers: ['Workday requires creating an applicant account'],
    submission: { method: 'manual', submittedAt: isoTime(-40), finalUrl: null, confirmationText: null, sandbox: false, screenshot: false },
  },
]

// ── Insert ───────────────────────────────────────────────────

const insertJob = sqlite.prepare(`insert into jobs (
  source, source_id, title, company, location, remote_type, salary_min, salary_max, salary_currency, description, url, tags,
  match_score, match_reasoning, status, found_at, apply_url, ats_type, posting_text, enriched_at, comp_json, total_comp_estimate,
  requirements_json, skills_score, comp_score, learned_adjustment, score_breakdown, scored_at, is_sandbox
) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)

const insertApp = sqlite.prepare(`insert into applications (
  job_id, tailored_resume_json, cover_letter, tailoring_notes, status, submitted_at, created_at, updated_at, status_detail, is_sandbox,
  form_snapshot_json, answers_json, form_screenshot_path, form_filled_at, gap_analysis_json, proposed_at, decided_at, submission_json,
  submit_error, submit_attempts
) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)

const insertDemo = sqlite.prepare(`insert into demo_projects (
  application_id, job_id, slug, title, summary, gap_addressed, tech_stack_json, status, local_path, repo_name, files_json, readme,
  test_command, test_output, tests_passed, cost_usd, error, created_at, built_at
) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)

const insertQuestion = sqlite.prepare(`insert into questions (
  question, context, category, application_id, status, asked_at, kind, subject, job_id, blocking, answer_type, choices_json, dedupe_key
) values (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`)

const updateAnswers = sqlite.prepare(`update applications set answers_json = ?, form_snapshot_json = ?, form_screenshot_path = ? where id = ?`)
const updateSubmission = sqlite.prepare(`update applications set submission_json = ? where id = ?`)

const screenshotJobs: Array<{ file: string; html: string }> = []
const summaryRows: string[] = []

sqlite.transaction(() => {
  for (const f of fixtures) {
    const posting = stripHtml(f.src.description)
    const applyUrl = f.applyUrl ?? sandboxApplyUrl
    const total = f.comp.totalEstimateMin !== null && f.comp.totalEstimateMax !== null ? Math.round((f.comp.totalEstimateMin + f.comp.totalEstimateMax) / 2) : null
    const job = insertJob.run(
      'fixture', `fixture-${f.key}`, f.src.title, f.src.company, f.src.location, f.src.remote_type, f.src.salary_min, f.src.salary_max, f.src.salary_currency,
      f.src.description, f.src.url, f.src.tags,
      f.score.final, f.score.skills.reasoning, 'reviewed', sqlTime(-f.proposedMinutesAgo - 300), applyUrl, f.atsType, posting, sqlTime(-f.proposedMinutesAgo - 240),
      JSON.stringify(f.comp), total, JSON.stringify(f.requirements), f.score.skills.score, f.score.compensation.score, f.score.learned.total,
      JSON.stringify(f.score), sqlTime(-f.proposedMinutesAgo - 200),
    )
    const jobId = Number(job.lastInsertRowid)

    const coverLetter = coverLetterFor(f.src.company, f.src.title, f.focus)
    const resume = resumeFor(f.resumeOrder, `Reordered bullets to lead with ${f.resumeOrder.slice(0, 3).join(', ')}. Wording comes from the knowledge base unchanged.`,
      f.demo && f.demo.status !== 'failed' ? [{ name: f.demo.title, description: f.demo.summary, url: null }] : [])

    const decided = f.decidedMinutesAgo !== undefined ? sqlTime(-f.decidedMinutesAgo) : null
    const app = insertApp.run(
      jobId, JSON.stringify(resume), coverLetter, resume.tailoringNotes, f.status,
      f.submission?.method === 'automated' ? sqlTime(-(f.decidedMinutesAgo ?? 0) + 2) : null,
      sqlTime(-f.proposedMinutesAgo - 30), sqlTime(-(f.decidedMinutesAgo ?? f.proposedMinutesAgo)), f.statusDetail,
      null, null, null, sqlTime(-f.proposedMinutesAgo - 5), f.gap ? JSON.stringify(f.gap) : null, sqlTime(-f.proposedMinutesAgo), decided,
      null, f.submitError ?? null, f.submitAttempts ?? 0,
    )
    const appId = Number(app.lastInsertRowid)

    // Form fields: the base set plus one field per blocking question.
    const fields = baseFields(coverLetter)
    if (f.demo && f.demo.status !== 'failed') {
      fields.push({ id: 'portfolio_note', selector: '#portfolio_note', label: 'Anything else you would like us to know?', type: 'textarea', required: false,
        answer: { value: `Demo project for this role: ${f.demo.title}. Link added once you approve and it is published.`, source: 'generated', sourceDetail: `demo_projects:${f.demo.slug}`, confidence: 'medium', filled: true } })
    }
    for (const q of f.questions ?? []) {
      const row = insertQuestion.run(
        q.question, q.context, q.kind === 'preference' ? 'preference' : 'technical', appId, sqlTime(-f.proposedMinutesAgo - 10),
        q.kind, q.subject, jobId, q.blocking ? 1 : 0, q.answerType, q.choices ? JSON.stringify(q.choices) : null,
        `${q.kind}:${q.subject.toLowerCase().replace(/[^a-z0-9+#.]+/g, ' ').trim()}`,
      )
      if (q.fieldId) {
        fields.push({ id: q.fieldId, selector: `#${q.fieldId}`, label: q.question, type: q.answerType === 'yes_no' ? 'radio' : 'text', required: true, options: q.answerType === 'yes_no' ? ['Yes', 'No'] : undefined,
          answer: { value: null, source: 'question', sourceDetail: `questions:${row.lastInsertRowid}`, confidence: 'low', needsQuestionId: Number(row.lastInsertRowid), filled: false } })
      }
    }
    const { snapshot, answers } = formFor(fields, `${f.src.title} application`, f.atsType, applyUrl, { requiresAccount: f.requiresAccount, blockers: f.blockers })
    let screenshotPath: string | null = null
    if (f.status !== 'needs_manual') {
      screenshotPath = join(dataDir, 'screenshots', `fixture-${appId}-form.png`)
      screenshotJobs.push({ file: screenshotPath, html: formHtml(f.src.company, f.src.title, answers) })
    }
    updateAnswers.run(JSON.stringify(answers), JSON.stringify(snapshot), screenshotPath, appId)

    if (f.submission) {
      let shot: string | null = null
      if (f.submission.screenshot) {
        shot = join(dataDir, 'screenshots', `fixture-${appId}-submitted.png`)
        screenshotJobs.push({ file: shot, html: confirmationHtml(f.src.company, f.src.title, new Date(f.submission.submittedAt).toLocaleString('en-US')) })
      }
      const { screenshot: _s, ...rest } = f.submission
      updateSubmission.run(JSON.stringify({ ...rest, screenshotPath: shot } satisfies SubmissionResult), appId)
    }

    if (f.demo) {
      insertDemo.run(
        appId, jobId, f.demo.slug, f.demo.title, f.demo.summary, f.demo.gap, JSON.stringify(f.demo.stack), f.demo.status,
        join(dataDir, 'demos', f.demo.slug), f.demo.slug, JSON.stringify(f.demo.files), f.demo.readme, f.demo.testCommand, f.demo.testOutput,
        f.demo.testsPassed === null ? null : f.demo.testsPassed ? 1 : 0, 0.42, f.demo.error ?? null, sqlTime(-f.proposedMinutesAgo - 60), sqlTime(-f.proposedMinutesAgo - 20),
      )
    }
    summaryRows.push(`  #${appId}  ${f.status.padEnd(13)} ${String(f.score.final).padStart(3)}  ${f.src.title} at ${f.src.company}`)
  }

  // Pipeline health fixtures, tagged so a re-run replaces them.
  const runIns = sqlite.prepare(`insert into pipeline_runs (task, trigger, status, started_at, finished_at, stats_json, error, host) values (?, ?, ?, ?, ?, ?, ?, 'dev-seed-review')`)
  runIns.run('pipeline:daily', 'schedule', 'failed', sqlTime(-60 * 24 - 120), sqlTime(-60 * 24 - 112), null, 'jobs:enrich failed: Error: fetch failed (ECONNRESET) for 3 of 41 postings')
  runIns.run('pipeline:daily', 'schedule', 'succeeded', sqlTime(-180), sqlTime(-171), JSON.stringify({ steps: { 'learn:daily': 'succeeded', 'jobs:search': 'succeeded', 'jobs:enrich': 'succeeded', 'jobs:match': 'succeeded', 'applications:prepare': 'succeeded', 'demos:build': 'succeeded' } }), null)
  sqlite.prepare(`insert into ai_calls (purpose, model, input_tokens, output_tokens, cost_usd, created_at) values ('dev-seed-review', 'claude-haiku-4-5', 182000, 41000, 1.84, ?)`).run(sqlTime(-170))
})()

// ── Optional: prepare the sandbox employer's job (created by POST /api/sandbox/seed-job) ──
// The prepare step is not built in every tree, so this stands in for it: a proposed
// application for the newest sandbox job that has none, ready for a real approve.
if (process.argv.includes('--sandbox-job')) {
  const sj = sqlite.prepare(`select j.* from jobs j where j.source = 'sandbox' and j.is_sandbox = 1
    and not exists (select 1 from applications a where a.job_id = j.id) order by j.id desc limit 1`).get() as (SourceJob & { posting_text: string | null; apply_url: string | null }) | undefined
  if (!sj) {
    console.log('No unprepared sandbox job. Run POST /api/sandbox/seed-job first.')
  }
  else {
    const text = sj.posting_text || stripHtml(sj.description)
    const comp: CompensationBreakdown = {
      currency: 'USD', baseMin: 165000, baseMax: 190000, basePeriod: 'year', baseAnnualMin: 165000, baseAnnualMax: 190000,
      bonus: quoteFrom(text, 'bonus target') ? { description: '10% of base', estimatedAnnual: 17750, quote: quoteFrom(text, 'bonus target')! } : null,
      equity: null,
      benefits: [
        ...benefit('Medical, dental, vision', 'health', 'Employee premiums paid in full', text, 'Medical, dental'),
        ...benefit('401(k) with 4% match', 'retirement', '4% of base', text, '401(k)', 7100),
        ...benefit('25 days PTO plus 10 holidays', 'pto', '', text, 'paid time off'),
        ...benefit('Learning budget and home office stipend', 'learning', '$1,500 learning, $1,000 home office', text, 'learning budget', 2500),
      ],
      totalEstimateMin: 191850, totalEstimateMax: 216850, confidence: 'stated',
      notes: 'Bonus at target. Benefits valued only where the posting states a figure.', extractedAt: isoTime(-30),
    }
    const score = breakdown({
      skills: 86, skillsReason: 'Laravel, TypeScript, Vue 3, MySQL, GitHub Actions, and AWS all match. Go is a nice to have.',
      matched: ['PHP', 'Laravel', 'TypeScript', 'Vue.js', 'MySQL', 'GitHub Actions', 'AWS'], missing: ['Go'],
      comp: 90, compReason: 'Stated base of $165,000 to $190,000 clears your floor before bonus.', estimate: 204350, learned: [],
    })
    const requirements = [
      req('Strong PHP (Laravel) and TypeScript', 'language', true, 'have', 'skill:Laravel'),
      req('Vue 3 and the Composition API', 'framework', true, 'have', 'skill:Vue.js'),
      req('Leading or mentoring engineers', 'experience', true, 'have', 'preference:Leadership Interest'),
      req('Go in production', 'language', false, 'lack', null),
    ]
    sqlite.prepare(`update jobs set comp_json = ?, total_comp_estimate = ?, requirements_json = ?, score_breakdown = ?, match_score = ?,
      skills_score = ?, comp_score = ?, learned_adjustment = 0, scored_at = ?, enriched_at = ?, status = 'reviewed' where id = ?`)
      .run(JSON.stringify(comp), 204350, JSON.stringify(requirements), JSON.stringify(score), score.final, 86, 90, sqlTime(-20), sqlTime(-25), sj.id)
    const letter = coverLetterFor(sj.company, sj.title, 'I build Laravel APIs and Vue 3 front ends, and I coach the developers I work with.')
    const resume = resumeFor(['Laravel', 'Vue', 'GitHub Actions', 'coach'], 'Reordered bullets to lead with Laravel, Vue, GitHub Actions. Wording comes from the knowledge base unchanged.')
    const applyUrl = sj.apply_url || sandboxApplyUrl
    const app = insertApp.run(sj.id, JSON.stringify(resume), letter, resume.tailoringNotes, 'proposed', null, sqlTime(-15), sqlTime(-10),
      'Ready for review', null, null, null, sqlTime(-12), null, sqlTime(-10), null, null, null, 0)
    const appId = Number(app.lastInsertRowid)
    const { snapshot, answers } = formFor(baseFields(letter), `${sj.title} application`, 'sandbox', applyUrl)
    const shot = join(dataDir, 'screenshots', `sandbox-${appId}-form.png`)
    updateAnswers.run(JSON.stringify(answers), JSON.stringify(snapshot), shot, appId)
    screenshotJobs.push({ file: shot, html: formHtml(sj.company, sj.title, answers) })
    console.log(`Prepared sandbox job #${sj.id} as application #${appId} (proposed, score ${score.final}).`)
  }
}

// Screenshots from earlier runs belong to rows that no longer exist.
const shotDir = join(dataDir, 'screenshots')
if (existsSync(shotDir)) {
  for (const f of readdirSync(shotDir)) if (/^fixture-\d+-(form|submitted)\.png$/.test(f)) rmSync(join(shotDir, f))
}
const shots = await renderScreenshots(screenshotJobs)
console.log(`Seeded ${fixtures.length} fixture applications into ${dbPath} (every row is_sandbox=1):`)
console.log(summaryRows.join('\n'))
console.log(`Rendered ${shots} screenshots under ${join(dataDir, 'screenshots')}.`)
sqlite.close()

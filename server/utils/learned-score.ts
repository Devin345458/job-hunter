import { and, eq, ne } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import { learnedRules } from '../db/schema'
import type { jobs } from '../db/schema'
import type { Requirement, ScoreBreakdown, ScoreComponent } from '#shared/types/pipeline'
import type { RuleKind } from '#shared/types/learning'
import { htmlToText, parseJson } from './review'

// Owned by capability D (learning). Scoring (capability A) adds this to every job's score.
// Returns the score points that learned rules add or subtract for one job, with one
// component per rule that matched, so the dashboard can say why a score moved.

type JobRow = InferSelectModel<typeof jobs>
export type LearnedRuleRow = InferSelectModel<typeof learnedRules>

// ── Normalizing terms so "Node.js", "node" and "NodeJS" are one thing ──

const TERM_ALIASES: Record<string, string> = {
  golang: 'go',
  k8s: 'kubernetes',
  postgres: 'postgresql',
  js: 'javascript',
  ts: 'typescript',
  nodejs: 'node',
  vuejs: 'vue',
  reactjs: 'react',
  'c sharp': 'c#',
  'on site': 'onsite',
  'on-site': 'onsite',
}

/** Lowercase, drop a trailing ".js" or "js", collapse spaces, apply a few aliases. */
export function ruleTerm(raw: string): string {
  let t = raw.toLowerCase().trim().replace(/\s+/g, ' ')
  t = t.replace(/\.js$/, '').replace(/^(\w{3,})js$/, '$1')
  return TERM_ALIASES[t] ?? t
}

const COMPANY_SUFFIXES = /\b(inc|incorporated|llc|ltd|limited|gmbh|corp|corporation|co|company|ag|sa|plc|bv|oy|ab|srl)\b\.?/g

/** Lowercase company name without punctuation or legal suffixes, e.g. "Acme, Inc." becomes "acme". */
export function ruleCompanyKey(raw: string | null | undefined): string {
  if (!raw) return ''
  return raw.toLowerCase()
    .replace(/[^\p{L}\p{N}&+ ]+/gu, ' ')
    .replace(COMPANY_SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Whole-word match that treats + and # as part of a word, so "c" never matches "c++". */
export function ruleWordMatch(text: string, term: string): boolean {
  if (!text || !term) return false
  return new RegExp(`(^|[^a-z0-9+#])${escapeRegex(term)}($|[^a-z0-9+#])`, 'i').test(text)
}

// ── Seniority vocabulary shared with rule building ──

/** Words that mark a title as junior or entry level. */
export const RULE_JUNIOR_MARKERS = ['junior', 'jr', 'entry level', 'entry-level', 'associate', 'intern', 'internship', 'graduate', 'apprentice', 'trainee', 'ii']
/** Words that mark a title above senior individual contributor. */
export const RULE_ABOVE_SENIOR_MARKERS = ['staff', 'principal', 'distinguished', 'fellow', 'director', 'head', 'vp', 'vice president', 'chief', 'cto', 'manager', 'management', 'architect', 'lead']
/** Any seniority word. A title with none of these is "unmarked". */
export const RULE_SENIORITY_MARKERS = ['senior', 'sr', ...RULE_ABOVE_SENIOR_MARKERS]

export function ruleTitleMarkers(title: string | null | undefined, markers: string[]): string[] {
  const t = (title || '').toLowerCase()
  return markers.filter(m => ruleWordMatch(t, m))
}

export function ruleHasSeniority(title: string | null | undefined): boolean {
  return ruleTitleMarkers(title, RULE_SENIORITY_MARKERS).length > 0 || ruleTitleMarkers(title, RULE_JUNIOR_MARKERS).length > 0
}

// ── What a rule is matched against ──

/** The parts of a job (or of a decision's features snapshot) that rules look at. */
export interface RuleMatchContext {
  title: string
  company: string
  location: string
  remoteType: string
  /** Normalized technology terms: tags, matched and missing skills. */
  terms: Set<string>
  /** Lowercased requirement texts. */
  requirements: string
  /** Lowercased title, company, tags and posting text, for keyword and industry rules. */
  text: string
  comp: number | null
}

export function ruleCompFigure(v: { totalCompEstimate?: number | null; salaryMin?: number | null; salaryMax?: number | null }): number | null {
  if (typeof v.totalCompEstimate === 'number' && v.totalCompEstimate > 0) return v.totalCompEstimate
  const min = typeof v.salaryMin === 'number' && v.salaryMin > 0 ? v.salaryMin : null
  const max = typeof v.salaryMax === 'number' && v.salaryMax > 0 ? v.salaryMax : null
  if (min && max) return Math.round((min + max) / 2)
  return max ?? min
}

export function ruleContextOfJob(job: JobRow): RuleMatchContext {
  const tags = parseJson<string[]>(job.tags, [])
  const breakdown = parseJson<ScoreBreakdown | null>(job.scoreBreakdown, null)
  const requirements = parseJson<Requirement[]>(job.requirementsJson, [])
  const terms = new Set<string>([
    ...tags,
    ...(breakdown?.skills.matched ?? []),
    ...(breakdown?.skills.missing ?? []),
  ].map(ruleTerm))
  const posting = job.postingText || htmlToText(job.description) || ''
  return {
    title: (job.title || '').toLowerCase(),
    company: ruleCompanyKey(job.company),
    location: (job.location || '').toLowerCase(),
    remoteType: (job.remoteType || '').toLowerCase(),
    terms,
    requirements: requirements.map(r => r.text).join('\n').toLowerCase(),
    text: [job.title, job.company, tags.join(' '), posting].join('\n').toLowerCase(),
    comp: ruleCompFigure(job),
  }
}

/** Snapshot stored in decisions.features_json by recordDecision() in review.ts. */
export interface LearnedFeatureSnapshot {
  title?: string | null
  company?: string | null
  location?: string | null
  remoteType?: string | null
  source?: string | null
  atsType?: string | null
  salaryMin?: number | null
  salaryMax?: number | null
  totalCompEstimate?: number | null
  compConfidence?: string | null
  tags?: string[]
  matchScore?: number | null
  skillsMatched?: string[]
  skillsMissing?: string[]
}

export function ruleContextOfFeatures(f: LearnedFeatureSnapshot): RuleMatchContext {
  const tags = f.tags ?? []
  return {
    title: (f.title || '').toLowerCase(),
    company: ruleCompanyKey(f.company),
    location: (f.location || '').toLowerCase(),
    remoteType: (f.remoteType || '').toLowerCase(),
    terms: new Set([...tags, ...(f.skillsMatched ?? []), ...(f.skillsMissing ?? [])].map(ruleTerm)),
    requirements: '',
    text: [f.title, f.company, tags.join(' ')].join('\n').toLowerCase(),
    comp: ruleCompFigure(f),
  }
}

/** True when a rule of this kind and pattern applies to the job or snapshot. */
export function ruleMatchesContext(kind: RuleKind | string, pattern: string, ctx: RuleMatchContext): boolean {
  switch (kind) {
    case 'remote_type':
      return ctx.remoteType === pattern
    case 'company':
      return !!ctx.company && ctx.company === pattern
    case 'tech':
      return ctx.terms.has(pattern) || ruleWordMatch(ctx.title, pattern) || ruleWordMatch(ctx.requirements, pattern)
    case 'title':
      return ruleWordMatch(ctx.title, pattern)
    case 'seniority':
      return pattern === 'unmarked' && !!ctx.title && !ruleHasSeniority(ctx.title)
    case 'keyword':
    case 'industry':
      return ruleWordMatch(ctx.text, pattern)
    case 'location':
      return ruleWordMatch(ctx.location, pattern)
    case 'comp_floor': {
      const floor = Number(pattern)
      return Number.isFinite(floor) && ctx.comp != null && ctx.comp <= floor
    }
    default:
      return false
  }
}

// ── Active score rules, cached for a rescore loop ──

let cache: { at: number; rules: LearnedRuleRow[] } | null = null
const CACHE_MS = 10_000

/** Call after any change to learned_rules so the next learnedAdjustment() reads fresh rules. */
export function invalidateLearnedRuleCache() {
  cache = null
}

export function activeLearnedScoreRules(): LearnedRuleRow[] {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rules
  const rules = useDb().select().from(learnedRules)
    .where(and(eq(learnedRules.effect, 'score'), eq(learnedRules.active, true), ne(learnedRules.weight, 0)))
    .all()
  cache = { at: Date.now(), rules }
  return rules
}

const KIND_LABELS: Record<string, string> = {
  remote_type: 'Work arrangement',
  company: 'Company',
  tech: 'Technology',
  title: 'Title',
  seniority: 'Seniority',
  keyword: 'Keyword',
  industry: 'Industry',
  location: 'Location',
  comp_floor: 'Pay floor',
}

export function learnedRuleLabel(rule: Pick<LearnedRuleRow, 'kind' | 'pattern'>): string {
  const kind = KIND_LABELS[rule.kind] ?? rule.kind
  if (rule.kind === 'comp_floor') return `${kind}: $${Number(rule.pattern).toLocaleString('en-US')}`
  if (rule.kind === 'seniority' && rule.pattern === 'unmarked') return `${kind}: no level in title`
  return `${kind}: ${rule.pattern}`
}

/** Kinds where several rules can match one job. Their combined effect is capped. */
const CAPPED_KINDS = new Set(['tech', 'keyword', 'industry', 'title', 'location'])
const KIND_NEGATIVE_CAP = 25
const POSITIVE_CAP = 10

export function learnedAdjustment(job: JobRow): { total: number; components: ScoreComponent[] } {
  // Sandbox rules (learned from test decisions) apply only to sandbox jobs, real rules only to real jobs.
  const rules = activeLearnedScoreRules().filter(r => r.isSandbox === job.isSandbox)
  if (rules.length === 0) return { total: 0, components: [] }
  const ctx = ruleContextOfJob(job)
  const components: ScoreComponent[] = []
  const negativeByKind = new Map<string, number>()
  let positive = 0
  for (const rule of rules) {
    if (!ruleMatchesContext(rule.kind, rule.pattern, ctx)) continue
    components.push({
      label: learnedRuleLabel(rule),
      points: rule.weight,
      detail: rule.explanation || '',
      ruleId: rule.id,
    })
    if (rule.weight < 0 && CAPPED_KINDS.has(rule.kind)) {
      negativeByKind.set(rule.kind, (negativeByKind.get(rule.kind) ?? 0) + rule.weight)
    }
    if (rule.weight > 0) positive += rule.weight
  }
  for (const [kind, sum] of negativeByKind) {
    if (sum < -KIND_NEGATIVE_CAP) {
      components.push({
        label: `Limit on ${KIND_LABELS[kind]?.toLowerCase() ?? kind} rules`,
        points: -KIND_NEGATIVE_CAP - sum,
        detail: `Several ${KIND_LABELS[kind]?.toLowerCase() ?? kind} rules matched this job. Together they can lower a score by at most ${KIND_NEGATIVE_CAP} points.`,
      })
    }
  }
  if (positive > POSITIVE_CAP) {
    components.push({
      label: 'Limit on approval rules',
      points: POSITIVE_CAP - positive,
      detail: `Rules learned from approvals can raise a score by at most ${POSITIVE_CAP} points.`,
    })
  }
  const total = components.reduce((s, c) => s + c.points, 0)
  return { total, components }
}

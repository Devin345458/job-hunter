import { and, desc, eq, gt, inArray, notInArray } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'
import { z } from 'zod'
import { decisions, jobs, learnedRules, pipelineRuns, scoreHistory } from '../db/schema'
import { REJECT_REASONS } from '#shared/types/pipeline'
import type { PipelineRunView, RejectSkillsMode, RejectSkillsRecord, ScoreBreakdown } from '#shared/types/pipeline'
import type { DecisionCounts, LearnedRuleView, LearningOverview, RuleEffect, RuleKind, ScoreMoveView, SearchAdjustments } from '#shared/types/learning'
import { aiStructured } from './ai'
import { loadKnowledge } from './knowledge'
import { askDailyQuestions } from './questions'
import { htmlToText, nowSql, parseJson } from './review'
import { outcomeRates } from './outcomes'
import { queueStaleSkillJudgments, rescoreJobs } from './scoring'
import { applyAllAnswersToOpenJobs } from './skill-claims'
import {
  RULE_ABOVE_SENIOR_MARKERS,
  RULE_JUNIOR_MARKERS,
  RULE_SENIORITY_MARKERS,
  invalidateLearnedRuleCache,
  ruleCompFigure,
  ruleCompanyKey,
  ruleContextOfFeatures,
  ruleContextOfJob,
  ruleHasSeniority,
  ruleMatchesContext,
  ruleTerm,
  ruleTitleMarkers,
  ruleWordMatch,
  type LearnedFeatureSnapshot,
  type LearnedRuleRow,
  type RuleMatchContext,
} from './learned-score'

// Owned by capability D (learning).
// Every approve and reject becomes evidence. Rules are recomputed from all evidence each time,
// so the result is the same no matter how often it runs. Devin's on/off switch on a rule is the
// only state that survives a recompute.

type DecisionRow = InferSelectModel<typeof decisions>
type JobRow = InferSelectModel<typeof jobs>

// ── Note mapping (reason "other" and "industry"), cached on the decision row ──

interface NoteRule {
  kind: RuleKind
  pattern: string
  direction: 'avoid' | 'prefer'
  search: 'none' | 'exclude' | 'boost'
}

interface NoteMapping {
  attemptedAt: string
  rules: NoteRule[]
  summary: string | null
  error: string | null
}

/**
 * decisions.features_json: the job snapshot from recordDecision(), the skills a wrong_stack
 * rejection named, and the note mapping once it ran.
 */
type StoredFeatures = LearnedFeatureSnapshot & { learning?: NoteMapping; rejectSkills?: RejectSkillsRecord }

const NOTE_KINDS = ['industry', 'keyword', 'company', 'title', 'tech', 'location', 'remote_type', 'comp_floor'] as const

const NoteRulesSchema = z.object({
  rules: z.array(z.object({
    kind: z.enum(NOTE_KINDS).describe('What the rule matches'),
    pattern: z.string().describe('Lowercase word or short phrase copied from the note or the job text. For comp_floor, digits only.'),
    direction: z.enum(['avoid', 'prefer']),
    search: z.enum(['none', 'exclude', 'boost']),
  })).describe('Zero to three rules'),
  summary: z.string().describe('One short sentence saying what Devin does not want, in plain words'),
})

function reasonLabel(code: string | null | undefined): string {
  if (!code) return 'Approved'
  return REJECT_REASONS.find(r => r.code === code)?.label ?? code
}

function features(d: DecisionRow): StoredFeatures {
  return parseJson<StoredFeatures>(d.featuresJson, {})
}

/** True for a reject whose reason needs Claude to turn it into rules, and that has not been mapped yet. */
export function needsNoteMapping(d: DecisionRow): boolean {
  if (d.decision !== 'reject') return false
  if (d.reasonCode !== 'other' && d.reasonCode !== 'industry') return false
  if (d.reasonCode === 'other' && !d.reasonText) return false
  const m = features(d).learning
  return !m || !!m.error
}

function parseNoteNumber(note: string | null | undefined): number | null {
  if (!note) return null
  const m = note.replace(/,/g, '').match(/\$?\s*(\d{2,3}(?:\.\d+)?)\s*k\b|\$?\s*(\d{5,7})\b/i)
  if (!m) return null
  const n = m[1] ? Math.round(Number(m[1]) * 1000) : Number(m[2])
  return n >= 20000 && n <= 2000000 ? n : null
}

function money(n: number) {
  return `$${Math.round(n).toLocaleString('en-US')}`
}

function validateNoteRule(rule: NoteRule, note: string, job: JobRow | undefined, f: StoredFeatures): NoteRule | null {
  const pattern = rule.pattern.toLowerCase().trim().replace(/\s+/g, ' ')
  if (rule.kind === 'comp_floor') {
    const n = parseNoteNumber(note)
    return n ? { ...rule, pattern: String(n) } : null
  }
  if (rule.kind === 'remote_type') {
    return ['onsite', 'hybrid', 'remote'].includes(pattern) ? { ...rule, pattern } : null
  }
  if (pattern.length < 2 || pattern.length > 40) return null
  const jobText = [f.title, f.company, f.location, (f.tags ?? []).join(' '), job ? (job.postingText || htmlToText(job.description) || '') : '']
    .join('\n').toLowerCase()
  // A rule must come from what Devin wrote or what the job says. Nothing invented.
  if (!ruleWordMatch(note.toLowerCase(), pattern) && !ruleWordMatch(jobText, pattern)) return null
  if (rule.kind === 'company') {
    const key = ruleCompanyKey(f.company)
    return key && ruleCompanyKey(pattern) && key.includes(ruleCompanyKey(pattern)) ? { ...rule, pattern: key } : null
  }
  if (rule.kind === 'tech') return { ...rule, pattern: ruleTerm(pattern) }
  return { ...rule, pattern }
}

/**
 * Asks Claude to turn one rejection note into rules and stores the answer in the decision's
 * features_json, so later recomputes reuse it instead of calling Claude again.
 * Returns true when the stored mapping changed.
 */
export async function mapDecisionNote(decisionId: number): Promise<boolean> {
  const db = useDb()
  const d = db.select().from(decisions).where(eq(decisions.id, decisionId)).get()
  if (!d || !needsNoteMapping(d)) return false
  const f = features(d)
  const job = db.select().from(jobs).where(eq(jobs.id, d.jobId)).get()
  const note = d.reasonText || ''
  const excerpt = (job?.postingText || htmlToText(job?.description) || '').slice(0, 1500)
  const comp = ruleCompFigure(f)
  let mapping: NoteMapping
  try {
    const out = await aiStructured(NoteRulesSchema, {
      purpose: 'learn_note',
      effort: 'low',
      maxTokens: 1500,
      ref: { type: 'decision', id: d.id },
      system: 'You turn one job rejection into matching rules for a job search tool. Use only words from the note or the job text. Never guess.',
      prompt: `Devin rejected this job listing.

Reason he picked: ${reasonLabel(d.reasonCode)}
His note: ${note || '(no note)'}

Job
Title: ${f.title ?? ''}
Company: ${f.company ?? ''}
Location: ${f.location ?? 'not stated'}
Work arrangement: ${f.remoteType ?? 'not stated'}
Tags: ${(f.tags ?? []).join(', ') || 'none'}
Pay: ${comp ? `${money(comp)} a year` : 'not stated'}
Posting excerpt:
"""
${excerpt || '(no posting text)'}
"""

Return zero to three rules that would catch other jobs he would reject for the same reason.

Rule kinds:
- industry: the industry or business domain, for example "crypto", "gambling", "defense", "adtech".
- keyword: another word or short phrase that marks jobs like this, for example "on call", "contract".
- company: this company, only when the note says he does not want this company.
- title: a word in the job title, for example "manager" or "junior".
- tech: a technology, for example "java" or "salesforce".
- location: a place or time zone, for example "germany" or "pst".
- remote_type: exactly "onsite", "hybrid", or "remote".
- comp_floor: a yearly pay figure in US dollars written as digits, for example "170000". Only when the note states a number.

Rules for each rule:
- pattern is lowercase, one to three words, and appears word for word in the note or in the job text above. comp_floor is the only exception.
- direction is "avoid" for things he does not want and "prefer" for things the note says he wants.
- search is "exclude" only when the note clearly says never to show jobs like this, "boost" only when the note clearly asks for more of them, and "none" otherwise.
- If the note is about his resume or cover letter, or you cannot tell what it means, return no rules.
${d.reasonCode === 'industry' ? '- The reason is the industry. Return at least one industry rule that names the industry of this job with a word that appears in the job text or the note.' : ''}`,
    })
    const rules = out.rules
      .map(r => validateNoteRule(r as NoteRule, note, job, f))
      .filter((r): r is NoteRule => !!r)
      .slice(0, 3)
    mapping = { attemptedAt: nowSql(), rules, summary: out.summary || null, error: null }
  }
  catch (e: any) {
    mapping = { attemptedAt: nowSql(), rules: [], summary: null, error: (e?.message || String(e)).slice(0, 500) }
  }
  db.update(decisions).set({ featuresJson: JSON.stringify({ ...f, learning: mapping }) }).where(eq(decisions.id, d.id)).run()
  if (mapping.error) console.warn(`[learning] could not map the note on decision ${d.id}: ${mapping.error}`)
  return !mapping.error
}

// ── Evidence and rule derivation ──

export interface RuleSpec {
  kind: RuleKind
  pattern: string
  effect: RuleEffect
  weight: number
  evidenceCount: number
  reasonCode: string
  explanation: string
  isSandbox: boolean
}

interface Evidence {
  kind: RuleKind
  pattern: string
  display: string
  direction: 'avoid' | 'prefer'
  isSandbox: boolean
  /** reason code (or "approve") to the decision ids that support the rule */
  reasons: Map<string, Set<number>>
  fromNote: Set<number>
  /** wrong_stack decisions that named this skill in the reject dialog, with what Devin said about it. */
  fromPick: Map<number, RejectSkillsMode>
  searchRequest: 'none' | 'exclude' | 'boost'
  notes: string[]
}

interface Policy { step: number; cap: number; min: number; base?: number; excludeAt?: number; boostAt?: number }

/**
 * How fast each kind of rule grows. weight = step x net evidence (company: base + step per extra),
 * capped. One not_remote rejection moves onsite and hybrid jobs 3 points; five move them 15.
 */
const AVOID_POLICY: Record<RuleKind, Policy> = {
  remote_type: { step: 3, cap: 20, min: 1 },
  comp_floor: { step: 3, cap: 20, min: 1 },
  tech: { step: 3, cap: 15, min: 2 },
  company: { base: 30, step: 5, cap: 40, min: 1, excludeAt: 1 },
  title: { step: 3, cap: 20, min: 1, excludeAt: 3 },
  seniority: { step: 3, cap: 15, min: 1 },
  industry: { step: 3, cap: 20, min: 1, excludeAt: 3 },
  keyword: { step: 3, cap: 20, min: 1, excludeAt: 3 },
  location: { step: 3, cap: 20, min: 1 },
}
/** Approvals add small positive weights for what approved jobs share (two or more). */
const PREFER_POLICY: Policy = { step: 1, cap: 6, min: 2, boostAt: 3 }
const EXCLUDABLE = new Set<RuleKind>(['company', 'keyword', 'industry', 'title', 'tech', 'location'])
const BOOSTABLE = new Set<RuleKind>(['tech', 'keyword', 'title', 'industry'])

function weightOf(p: Policy, n: number) {
  return p.base != null ? Math.min(p.cap, p.base + p.step * (n - 1)) : Math.min(p.cap, p.step * n)
}

/** Tags and skill names too generic to say anything about a stack. The reject dialog skips them too. */
export const GENERIC_TERMS = new Set([
  'fullstack', 'full stack', 'full-stack', 'backend', 'back-end', 'back end', 'frontend', 'front-end', 'front end',
  'api', 'apis', 'rest', 'saas', 'remote', 'startup', 'cloud', 'software', 'engineering', 'engineer', 'developer',
  'development', 'web', 'mobile', 'security', 'documentation', 'project management', 'technical support', 'onboarding',
  'responsive', 'editing', 'git', 'agile', 'scrum', 'data', 'analytics', 'design', 'ui', 'ux', 'testing', 'support',
  'management', 'marketing', 'sales', 'customer service', 'b2b', 'b2c', 'ecommerce', 'e-commerce', 'ai/ml', 'ai', 'ml',
])

const LOCATION_NOISE = new Set(['remote', 'anywhere', 'worldwide', 'global', 'hybrid', 'onsite', 'on-site', 'in office', 'fully remote', 'remote first', 'remote-first'])

const NEGATIVE_KNOWLEDGE = /^(does not know|has not done|no production experience)/i

/** Normalized skill names Devin has in the knowledge base (negative answers excluded). */
function knownSkillTerms(): Set<string> {
  const out = new Set<string>()
  for (const e of loadKnowledge('skill')) {
    if (NEGATIVE_KNOWLEDGE.test(e.value)) continue
    for (const part of e.key.split(/[/,]/)) {
      const t = ruleTerm(part)
      if (t) out.add(t)
    }
  }
  return out
}

function locationTokens(location: string | null | undefined): Array<{ key: string; display: string }> {
  if (!location) return []
  return location.split(/[,;/|()]+/)
    .map(s => s.trim())
    .filter(s => s.length >= 2 && !LOCATION_NOISE.has(s.toLowerCase()))
    .map(s => ({ key: s.toLowerCase(), display: s }))
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`
}

function title(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function evidenceCount(ev: Evidence): number {
  const ids = new Set<number>()
  for (const set of ev.reasons.values()) for (const id of set) ids.add(id)
  return ids.size
}

function mainReason(ev: Evidence): string {
  let best = ''
  let n = -1
  for (const [code, set] of ev.reasons) if (set.size > n) { best = code; n = set.size }
  return best
}

function whatDevinDid(ev: Evidence): string {
  const parts: string[] = []
  const sorted = [...ev.reasons].sort((a, b) => b[1].size - a[1].size)
  for (const [code, set] of sorted) {
    if (code === 'approve') parts.push(`applied to ${plural(set.size, 'job')}`)
    else parts.push(`rejected ${plural(set.size, 'job')} as ${reasonLabel(code)}`)
  }
  return `You ${parts.join(' and ')}`
}

function featurePhrase(ev: Evidence): string {
  const d = ev.display
  const one = evidenceCount(ev) === 1
  switch (ev.kind) {
    case 'tech': return ev.direction === 'prefer' ? ` that ${one ? 'uses' : 'use'} ${d}` : ` that asked for ${d}`
    case 'title': return ` with "${d}" in the title`
    case 'seniority': return ` whose ${one ? 'title has' : 'titles had'} no level`
    case 'industry': return ` in ${d}`
    case 'keyword': return ` that ${one ? 'mentions' : 'mention'} ${d}`
    case 'location': return ` located in ${d}`
    // A not-remote rejection already says it. Approvals name the arrangement they share.
    case 'remote_type': return ev.direction === 'prefer' ? ` that ${one ? 'was' : 'were'} ${d.toLowerCase()}` : ''
    default: return ''
  }
}

function subjectPhrase(kind: RuleKind, display: string, direction: 'avoid' | 'prefer' = 'avoid'): string {
  switch (kind) {
    case 'remote_type': return `${title(display)} jobs`
    case 'company': return `${display} jobs`
    case 'tech': return direction === 'prefer' ? `Jobs that use ${display}` : `Jobs that ask for ${display}`
    case 'title': return `Titles with "${display}"`
    case 'seniority': return 'Titles without a level such as Senior, Staff, or Lead'
    case 'industry':
    case 'keyword': return `Jobs that mention ${display}`
    case 'location': return `Jobs located in ${display}`
    case 'comp_floor': return `Jobs paying ${display} a year or less`
  }
}

/** A note shortened for a sentence, without its own closing punctuation. */
function quoteNote(note: string): string {
  const t = note.trim().replace(/\s+/g, ' ').replace(/[.!?]+$/, '')
  return t.length > 80 ? `${t.slice(0, 77).trimEnd()}...` : t
}

/** "You rejected 2 jobs for Ruby on Rails, which you do not have", when every decision named the skill. */
function pickedPhrase(ev: Evidence): string | null {
  if (ev.fromPick.size === 0 || ev.fromPick.size !== evidenceCount(ev)) return null
  const modes = new Set(ev.fromPick.values())
  const why = modes.size > 1 ? '' : modes.has('lack') ? ', which you do not have' : ', which you do not want to work with'
  return `You rejected ${plural(ev.fromPick.size, 'job')} for ${ev.display}${why}`
}

function explain(ev: Evidence, counter: number, effect: RuleEffect, weight: number): string {
  // When every piece of evidence is a note, the note says what the jobs had in common.
  const onlyNotes = ev.notes.length > 0 && ev.fromNote.size === evidenceCount(ev)
  const did = ev.kind === 'company'
    ? (evidenceCount(ev) === 1 ? `You rejected ${ev.display} as ${reasonLabel(mainReason(ev))}` : `You rejected ${plural(evidenceCount(ev), `${ev.display} job`)} as ${reasonLabel(mainReason(ev))}`)
    : pickedPhrase(ev) ?? `${whatDevinDid(ev)}${onlyNotes ? '' : featurePhrase(ev)}`
  const note = ev.notes.length ? `, noting "${quoteNote(ev.notes[0]!)}"` : ''
  const counterText = counter > 0 ? ` You also approved ${plural(counter, 'job')} like this.` : ''
  let effectText: string
  if (effect === 'score') {
    effectText = `${subjectPhrase(ev.kind, ev.display, ev.direction)} now score ${Math.abs(weight)} ${weight < 0 ? 'lower' : 'higher'}.`
  }
  else if (effect === 'exclude_search') {
    effectText = ev.kind === 'company' ? `Search now skips ${ev.display}.` : `Search now skips listings that mention "${ev.display}".`
  }
  else {
    effectText = `Search now looks for "${ev.display}" too.`
  }
  return `${did}${note}.${counterText} ${effectText}`
}

interface ScopedDecision {
  d: DecisionRow
  f: StoredFeatures
  ctx: RuleMatchContext
  isSandbox: boolean
}

/**
 * Pure: turns decisions into rule specs. Exported for tests and for the learning page preview.
 * knownSkills keeps wrong_stack rejections from penalizing what Devin already knows.
 */
export function deriveRules(scoped: ScopedDecision[], knownSkills: Set<string>): RuleSpec[] {
  const evidence = new Map<string, Evidence>()
  const compEvidence = new Map<boolean, Array<{ id: number; figure: number | null; note: string | null }>>()
  const approvals = scoped.filter(s => s.d.decision === 'approve')

  const add = (s: ScopedDecision, code: string, kind: RuleKind, pattern: string, display: string, direction: 'avoid' | 'prefer' = 'avoid', fromNote?: NoteRule, pick?: RejectSkillsMode) => {
    if (!pattern) return
    const key = `${s.isSandbox ? 1 : 0}|${direction}|${kind}|${pattern}`
    let ev = evidence.get(key)
    if (!ev) {
      ev = { kind, pattern, display, direction, isSandbox: s.isSandbox, reasons: new Map(), fromNote: new Set(), fromPick: new Map(), searchRequest: 'none', notes: [] }
      evidence.set(key, ev)
    }
    if (!ev.reasons.has(code)) ev.reasons.set(code, new Set())
    ev.reasons.get(code)!.add(s.d.id)
    if (pick) ev.fromPick.set(s.d.id, pick)
    if (fromNote) {
      ev.fromNote.add(s.d.id)
      if (fromNote.search !== 'none') ev.searchRequest = fromNote.search
      if (s.d.reasonText && !ev.notes.includes(s.d.reasonText)) ev.notes.push(s.d.reasonText)
    }
  }

  for (const s of scoped) {
    const { d, f } = s
    if (d.decision === 'approve') {
      const terms = new Map<string, string>()
      for (const raw of [...(f.tags ?? []), ...(f.skillsMatched ?? [])]) {
        const t = ruleTerm(raw)
        if (t && !GENERIC_TERMS.has(t) && !terms.has(t)) terms.set(t, raw)
      }
      for (const [t, raw] of terms) add(s, 'approve', 'tech', t, raw, 'prefer')
      if (f.remoteType) add(s, 'approve', 'remote_type', f.remoteType.toLowerCase(), f.remoteType.toLowerCase(), 'prefer')
      for (const m of ruleTitleMarkers(f.title, [...RULE_SENIORITY_MARKERS, ...RULE_JUNIOR_MARKERS])) add(s, 'approve', 'title', m, m, 'prefer')
      continue
    }
    const code = d.reasonCode || 'other'
    switch (code) {
      case 'not_remote':
        // A not-remote rejection is evidence against every non-remote arrangement.
        add(s, code, 'remote_type', 'onsite', 'onsite')
        add(s, code, 'remote_type', 'hybrid', 'hybrid')
        break
      case 'comp_too_low': {
        const job = ruleCompFigure(f)
        const stated = parseNoteNumber(d.reasonText)
        const figure = job != null || stated != null ? Math.max(job ?? 0, stated ?? 0) : null
        if (!compEvidence.has(s.isSandbox)) compEvidence.set(s.isSandbox, [])
        compEvidence.get(s.isSandbox)!.push({ id: d.id, figure, note: stated != null ? d.reasonText : null })
        break
      }
      case 'wrong_stack': {
        const seen = new Set<string>()
        // Skills Devin named in the reject dialog are the only evidence. Knowing a skill does not
        // filter it out here: "I have them but don't want to work with them" names known skills.
        const picks = f.rejectSkills?.skills ?? []
        if (picks.length > 0) {
          for (const p of picks) {
            const t = p.term || ruleTerm(p.label)
            if (t && !seen.has(t)) { seen.add(t); add(s, code, 'tech', t, p.label, 'avoid', undefined, f.rejectSkills!.mode === 'avoid' || p.kept ? 'avoid' : 'lack') }
          }
          break
        }
        for (const raw of f.skillsMissing ?? []) {
          const t = ruleTerm(raw)
          if (t && !GENERIC_TERMS.has(t) && !seen.has(t)) { seen.add(t); add(s, code, 'tech', t, raw) }
        }
        for (const raw of f.tags ?? []) {
          const t = ruleTerm(raw)
          if (t && !GENERIC_TERMS.has(t) && !knownSkills.has(t) && !seen.has(t)) { seen.add(t); add(s, code, 'tech', t, raw) }
        }
        break
      }
      case 'company':
        if (f.company) add(s, code, 'company', ruleCompanyKey(f.company), f.company)
        break
      case 'too_junior': {
        const markers = ruleTitleMarkers(f.title, RULE_JUNIOR_MARKERS)
        for (const m of markers) add(s, code, 'title', m, m)
        if (markers.length === 0 && f.title && !ruleHasSeniority(f.title)) add(s, code, 'seniority', 'unmarked', 'no level')
        break
      }
      case 'too_senior':
        for (const m of ruleTitleMarkers(f.title, RULE_ABOVE_SENIOR_MARKERS)) add(s, code, 'title', m, m)
        break
      case 'location':
        for (const t of locationTokens(f.location)) add(s, code, 'location', t.key, t.display)
        break
      case 'industry':
      case 'other':
        for (const r of f.learning?.rules ?? []) {
          if (r.kind === 'comp_floor') {
            if (!compEvidence.has(s.isSandbox)) compEvidence.set(s.isSandbox, [])
            compEvidence.get(s.isSandbox)!.push({ id: d.id, figure: Number(r.pattern), note: d.reasonText })
            continue
          }
          const display = r.kind === 'company' ? (f.company || r.pattern) : r.pattern
          add(s, code, r.kind, r.pattern, display, r.direction, r)
        }
        break
      // weak_materials and already_applied say nothing about which jobs to show.
    }
  }

  const specs: RuleSpec[] = []
  for (const ev of evidence.values()) {
    const n = evidenceCount(ev)
    const policy = ev.direction === 'prefer' ? PREFER_POLICY : AVOID_POLICY[ev.kind]
    // Approvals of jobs that match an avoid rule count against it.
    const counter = ev.direction === 'avoid'
      ? approvals.filter(a => a.isSandbox === ev.isSandbox && ruleMatchesContext(ev.kind, ev.pattern, a.ctx)).length
      : 0
    const net = n - counter
    // A note or a named skill is a direct statement, so one is enough.
    const min = ev.fromNote.size > 0 || ev.fromPick.size > 0 ? 1 : policy.min
    if (net < min) continue
    const sign = ev.direction === 'prefer' ? 1 : -1
    const weight = sign * weightOf(policy, net)
    const reasonCode = mainReason(ev)
    specs.push({ kind: ev.kind, pattern: ev.pattern, effect: 'score', weight, evidenceCount: n, reasonCode, explanation: explain(ev, counter, 'score', weight), isSandbox: ev.isSandbox })
    const noteAsks = ev.fromNote.size > 0
    if (ev.direction === 'avoid' && EXCLUDABLE.has(ev.kind)
      && ((policy.excludeAt != null && net >= policy.excludeAt) || (noteAsks && ev.searchRequest === 'exclude'))) {
      specs.push({ kind: ev.kind, pattern: ev.pattern, effect: 'exclude_search', weight: 0, evidenceCount: n, reasonCode, explanation: explain(ev, counter, 'exclude_search', 0), isSandbox: ev.isSandbox })
    }
    if (ev.direction === 'prefer' && BOOSTABLE.has(ev.kind)
      && ((policy.boostAt != null && net >= policy.boostAt) || (noteAsks && ev.searchRequest === 'boost'))) {
      specs.push({ kind: ev.kind, pattern: ev.pattern, effect: 'boost_search', weight: 0, evidenceCount: n, reasonCode, explanation: explain(ev, counter, 'boost_search', 0), isSandbox: ev.isSandbox })
    }
  }

  // One pay floor per scope: the best-paying job he still called too low.
  for (const [isSandbox, list] of compEvidence) {
    const figures = list.filter(x => x.figure != null && x.figure > 0)
    if (figures.length === 0) continue
    const floor = Math.round(Math.max(...figures.map(x => x.figure!)) / 1000) * 1000
    const n = list.length
    const counter = approvals.filter(a => a.isSandbox === isSandbox && a.ctx.comp != null && a.ctx.comp <= floor).length
    const net = n - counter
    if (net < AVOID_POLICY.comp_floor.min) continue
    const weight = -weightOf(AVOID_POLICY.comp_floor, net)
    const stated = list.find(x => x.note)
    const did = `You rejected ${plural(n, 'job')} as ${reasonLabel('comp_too_low')}, ${n === 1 ? 'paying' : 'the best paying'} about ${money(floor)} a year${stated ? ` (your note: "${quoteNote(stated.note!)}")` : ''}.`
    const counterText = counter > 0 ? ` You also approved ${plural(counter, 'job')} paying that or less.` : ''
    specs.push({
      kind: 'comp_floor',
      pattern: String(floor),
      effect: 'score',
      weight,
      evidenceCount: n,
      reasonCode: 'comp_too_low',
      explanation: `${did}${counterText} ${subjectPhrase('comp_floor', money(floor))} now score ${Math.abs(weight)} lower.`,
      isSandbox,
    })
  }
  return specs
}

// ── Storage ──

export interface RuleChange {
  ruleId: number
  kind: string
  pattern: string
  effect: string
  isSandbox: boolean
  oldWeight: number
  newWeight: number
  oldEvidence: number
  newEvidence: number
}

function ruleKey(r: { kind: string; pattern: string; effect: string; isSandbox: boolean }) {
  return `${r.isSandbox ? 1 : 0}|${r.kind}|${r.pattern}|${r.effect}`
}

const RETIRED = 'No decisions support this rule now.'

/**
 * Writes specs to learned_rules. Upserts by (kind, pattern, effect, is_sandbox), keeps the active
 * flag Devin set, and zeroes rules that lost all evidence instead of deleting them.
 */
export function syncRules(specs: RuleSpec[]): RuleChange[] {
  const db = useDb()
  const changes: RuleChange[] = []
  db.transaction((tx) => {
    const existing = tx.select().from(learnedRules).orderBy(learnedRules.id).all()
    const byKey = new Map<string, LearnedRuleRow>()
    for (const row of existing) if (!byKey.has(ruleKey(row))) byKey.set(ruleKey(row), row)
    const kept = new Set<number>()
    const now = nowSql()
    for (const spec of specs) {
      const row = byKey.get(ruleKey(spec))
      if (row) {
        kept.add(row.id)
        if (row.weight !== spec.weight || row.evidenceCount !== spec.evidenceCount || row.explanation !== spec.explanation || row.reasonCode !== spec.reasonCode) {
          tx.update(learnedRules).set({ weight: spec.weight, evidenceCount: spec.evidenceCount, explanation: spec.explanation, reasonCode: spec.reasonCode, updatedAt: now })
            .where(eq(learnedRules.id, row.id)).run()
          if (row.weight !== spec.weight || row.evidenceCount !== spec.evidenceCount) {
            changes.push({ ruleId: row.id, kind: row.kind, pattern: row.pattern, effect: row.effect, isSandbox: row.isSandbox, oldWeight: row.weight, newWeight: spec.weight, oldEvidence: row.evidenceCount, newEvidence: spec.evidenceCount })
          }
        }
        continue
      }
      // A new pay floor replaces the old one. If Devin had switched the old floor off, keep it off.
      let active = true
      if (spec.kind === 'comp_floor') {
        const prev = existing.filter(r => r.kind === 'comp_floor' && r.effect === spec.effect && r.isSandbox === spec.isSandbox).at(-1)
        if (prev) active = prev.active
      }
      const inserted = tx.insert(learnedRules).values({
        kind: spec.kind,
        pattern: spec.pattern,
        effect: spec.effect,
        weight: spec.weight,
        evidenceCount: spec.evidenceCount,
        reasonCode: spec.reasonCode,
        explanation: spec.explanation,
        active,
        isSandbox: spec.isSandbox,
      }).returning().get()
      kept.add(inserted.id)
      changes.push({ ruleId: inserted.id, kind: spec.kind, pattern: spec.pattern, effect: spec.effect, isSandbox: spec.isSandbox, oldWeight: 0, newWeight: spec.weight, oldEvidence: 0, newEvidence: spec.evidenceCount })
    }
    for (const row of existing) {
      if (kept.has(row.id) || (row.weight === 0 && row.evidenceCount === 0)) continue
      tx.update(learnedRules).set({ weight: 0, evidenceCount: 0, explanation: RETIRED, updatedAt: now }).where(eq(learnedRules.id, row.id)).run()
      changes.push({ ruleId: row.id, kind: row.kind, pattern: row.pattern, effect: row.effect, isSandbox: row.isSandbox, oldWeight: row.weight, newWeight: 0, oldEvidence: row.evidenceCount, newEvidence: 0 })
    }
  })
  invalidateLearnedRuleCache()
  return changes
}

export interface RecomputeResult {
  decisionsUsed: number
  decisionsSkipped: number
  specs: number
  changes: RuleChange[]
}

/**
 * Rebuilds every rule from every decision. Idempotent.
 * A sandbox decision counts only when its job is a sandbox job, and then it makes sandbox rules,
 * which apply to sandbox jobs only and never to search. Test data never shapes the real search.
 */
/**
 * The decisions learning reads: Apply (stage 1) and Approve (stage 2) are both the positive
 * signal, counted once per application as decision 'approve'; a Reject is the negative one. When
 * Devin applied and then rejected the same application at stage 2, the reject is his last word
 * and the positive is dropped. Employer outcomes (decision 'outcome') are left out.
 */
export function learningDecisions(): DecisionRow[] {
  const all = useDb().select().from(decisions).where(inArray(decisions.decision, ['apply', 'approve', 'reject'])).orderBy(decisions.id).all()
  const rejected = new Map<number, number>()
  for (const d of all) if (d.decision === 'reject') rejected.set(d.applicationId, d.id)
  const positive = new Set<number>()
  const out: DecisionRow[] = []
  for (const d of all) {
    if (d.decision === 'reject') { out.push(d); continue }
    if (positive.has(d.applicationId)) continue
    if ((rejected.get(d.applicationId) ?? 0) > d.id) continue
    positive.add(d.applicationId)
    out.push(d.decision === 'apply' ? { ...d, decision: 'approve' } : d)
  }
  return out
}

export function recomputeRules(): RecomputeResult {
  const db = useDb()
  // Apply, approve, and reject only (learningDecisions). Employer outcomes are decisions rows too
  // (decision 'outcome'), and deriveRules reads anything that is not an approve as a rejection;
  // outcomes never move a score.
  const all = learningDecisions()
  const jobIds = [...new Set(all.map(d => d.jobId))]
  const sandboxJobs = new Set(
    jobIds.length
      ? db.select({ id: jobs.id, isSandbox: jobs.isSandbox }).from(jobs).where(inArray(jobs.id, jobIds)).all().filter(j => j.isSandbox).map(j => j.id)
      : [],
  )
  const scoped: ScopedDecision[] = []
  let skipped = 0
  for (const d of all) {
    const jobIsSandbox = sandboxJobs.has(d.jobId)
    if (d.isSandbox && !jobIsSandbox) { skipped++; continue }
    const f = features(d)
    scoped.push({ d, f, ctx: ruleContextOfFeatures(f), isSandbox: jobIsSandbox })
  }
  const specs = deriveRules(scoped, knownSkillTerms())
  const changes = syncRules(specs)
  return { decisionsUsed: scoped.length, decisionsSkipped: skipped, specs: specs.length, changes }
}

// ── Hooks the rest of the pipeline calls ──

/**
 * Runs right after every approve and reject is recorded (awaited by the review routes, so it
 * stays fast: no Claude call and no rescore here). Rules update at once. Scores follow on the
 * next learn:daily, or at once when Devin flips a rule on the learning page.
 * A note that needs Claude is mapped in the background, then rules are recomputed again.
 */
export async function onDecision(decisionId: number): Promise<void> {
  const d = useDb().select().from(decisions).where(eq(decisions.id, decisionId)).get()
  if (!d) return
  const result = recomputeRules()
  console.log(`[learning] decision ${d.id} (${d.decision}${d.reasonCode ? ` ${d.reasonCode}` : ''}${d.isSandbox ? ', sandbox' : ''}): ${result.changes.length} rule change(s)`)
  if (needsNoteMapping(d)) {
    void mapDecisionNote(d.id)
      .then((mapped) => {
        if (!mapped) return
        const again = recomputeRules()
        console.log(`[learning] decision ${d.id} note mapped: ${again.changes.length} rule change(s)`)
      })
      .catch(e => console.error(`[learning] note mapping failed for decision ${d.id}`, e))
  }
}

const CLOSED_JOB_STATUSES = ['rejected', 'expired', 'applied']

function openJobs(): JobRow[] {
  return useDb().select().from(jobs).where(notInArray(jobs.status, CLOSED_JOB_STATUSES)).all()
}

/** Open jobs a rule would match, in the rule's own scope (sandbox or real). */
export function openJobIdsMatching(rule: Pick<LearnedRuleRow, 'kind' | 'pattern' | 'isSandbox'>, candidates = openJobs()): number[] {
  return candidates
    .filter(j => j.isSandbox === rule.isSandbox && ruleMatchesContext(rule.kind, rule.pattern, ruleContextOfJob(j)))
    .map(j => j.id)
}

/** Devin's on/off switch. Rescores the open jobs the rule touches so the change shows at once. */
export async function setRuleActive(ruleId: number, active: boolean): Promise<{ rule: LearnedRuleRow; rescored: number }> {
  const db = useDb()
  const rule = db.select().from(learnedRules).where(eq(learnedRules.id, ruleId)).get()
  if (!rule) throw createError({ statusCode: 404, statusMessage: 'Rule not found' })
  if (rule.active !== active) {
    db.update(learnedRules).set({ active, updatedAt: nowSql() }).where(eq(learnedRules.id, ruleId)).run()
    invalidateLearnedRuleCache()
  }
  let rescored = 0
  if (rule.effect === 'score' && rule.weight !== 0) {
    const ids = openJobIdsMatching(rule)
    if (ids.length) rescored = (await rescoreJobs(ids, 'rule_change')).rescored
  }
  return { rule: { ...rule, active }, rescored }
}

/** Keywords and companies the search task should skip or add. Sandbox rules never count here. */
export function searchAdjustments(): SearchAdjustments {
  const rows = useDb().select().from(learnedRules)
    .where(and(eq(learnedRules.active, true), eq(learnedRules.isSandbox, false), gt(learnedRules.evidenceCount, 0), inArray(learnedRules.effect, ['exclude_search', 'boost_search'])))
    .all()
  const uniq = (xs: string[]) => [...new Set(xs)].sort()
  return {
    excludedKeywords: uniq(rows.filter(r => r.effect === 'exclude_search' && r.kind !== 'company').map(r => r.pattern)),
    excludedCompanies: uniq(rows.filter(r => r.effect === 'exclude_search' && r.kind === 'company').map(r => r.pattern)),
    boostKeywords: uniq(rows.filter(r => r.effect === 'boost_search').map(r => r.pattern)),
  }
}

/**
 * Convenience for the search task: why a fetched listing should be skipped, or null to keep it.
 * Pass the adjustments once per run so this stays cheap inside a loop.
 */
export function learnedSearchExclusion(
  listing: { title?: string | null; company?: string | null; description?: string | null; tags?: string[] | null },
  adj: SearchAdjustments = searchAdjustments(),
): string | null {
  const company = ruleCompanyKey(listing.company)
  if (company && adj.excludedCompanies.includes(company)) return `company ${listing.company}`
  const text = [listing.title, (listing.tags ?? []).join(' '), htmlToText(listing.description) ?? ''].join('\n').toLowerCase()
  const hit = adj.excludedKeywords.find(k => ruleWordMatch(text, k))
  return hit ? `keyword "${hit}"` : null
}

// ── Views for the learning page ──

export function listRuleViews(): LearnedRuleView[] {
  const rows = useDb().select().from(learnedRules).where(gt(learnedRules.evidenceCount, 0)).all()
  const open = openJobs()
  return rows
    .map(r => ({
      id: r.id,
      kind: r.kind as RuleKind,
      pattern: r.pattern,
      effect: r.effect as RuleEffect,
      weight: r.weight,
      evidenceCount: r.evidenceCount,
      reasonCode: r.reasonCode,
      reasonLabel: r.reasonCode === 'approve' ? 'Applied' : reasonLabel(r.reasonCode),
      explanation: r.explanation,
      active: r.active,
      isSandbox: r.isSandbox,
      updatedAt: r.updatedAt,
      matchingOpenJobs: r.effect === 'score' ? openJobIdsMatching(r, open).length : 0,
    }))
    .sort((a, b) => Number(a.isSandbox) - Number(b.isSandbox) || Math.abs(b.weight) - Math.abs(a.weight) || b.evidenceCount - a.evidenceCount || a.id - b.id)
}

export function decisionCounts(): DecisionCounts {
  const rows = learningDecisions()
  const byReason = new Map<string, number>()
  for (const r of rows) if (r.decision === 'reject') byReason.set(r.reasonCode || 'other', (byReason.get(r.reasonCode || 'other') ?? 0) + 1)
  return {
    approvals: rows.filter(r => r.decision === 'approve').length,
    rejections: rows.filter(r => r.decision === 'reject').length,
    sandbox: rows.filter(r => r.isSandbox).length,
    byReason: [...byReason].map(([code, count]) => ({ code, label: reasonLabel(code), count })).sort((a, b) => b.count - a.count),
  }
}

export function learningOverview(): LearningOverview {
  const run = useDb().select().from(pipelineRuns).where(eq(pipelineRuns.task, 'learn:daily')).orderBy(desc(pipelineRuns.id)).limit(1).get()
  const lastRun: PipelineRunView | null = run
    ? {
        id: run.id,
        task: run.task,
        trigger: run.trigger,
        status: run.status as PipelineRunView['status'],
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        stats: parseJson<Record<string, unknown> | null>(run.statsJson, null),
        error: run.error,
        host: run.host,
      }
    : null
  return { decisions: decisionCounts(), rules: listRuleViews(), search: searchAdjustments(), lastRun, outcomes: outcomeRates() }
}

/** Recent score changes, newest first, each with the score the job had just before it. */
export function recentScoreMoves(limit = 50): ScoreMoveView[] {
  const db = useDb()
  const rows = db.select({ h: scoreHistory, title: jobs.title, company: jobs.company, isSandbox: jobs.isSandbox })
    .from(scoreHistory)
    .innerJoin(jobs, eq(scoreHistory.jobId, jobs.id))
    .where(notInArray(scoreHistory.reason, ['initial']))
    .orderBy(desc(scoreHistory.id))
    .limit(limit)
    .all()
  if (rows.length === 0) return []
  const jobIds = [...new Set(rows.map(r => r.h.jobId))]
  const history = db.select({ id: scoreHistory.id, jobId: scoreHistory.jobId, score: scoreHistory.score })
    .from(scoreHistory).where(inArray(scoreHistory.jobId, jobIds)).orderBy(scoreHistory.id).all()
  return rows.flatMap(({ h, title, company, isSandbox }): ScoreMoveView[] => {
    const prev = history.filter(x => x.jobId === h.jobId && x.id < h.id).at(-1)
    // A history row that left the score where it was is not a move.
    if (prev && prev.score === h.score) return []
    const breakdown = parseJson<ScoreBreakdown | null>(h.breakdownJson, null)
    return [{
      id: h.id,
      jobId: h.jobId,
      jobTitle: title,
      company,
      isSandbox,
      oldScore: prev?.score ?? null,
      newScore: h.score,
      learnedAdjustment: h.learnedAdjustment,
      reason: h.reason,
      computedAt: h.computedAt,
      components: breakdown?.learned.components ?? [],
    }]
  })
}

// ── The daily task body ──

export async function runDailyLearning(log: (msg: string) => void) {
  const db = useDb()
  // 1. Map rejection notes Claude has not read yet (cached on the decision, so each runs once).
  const pending = db.select().from(decisions).where(eq(decisions.decision, 'reject')).all().filter(needsNoteMapping).slice(0, 20)
  let notesMapped = 0
  let noteErrors = 0
  for (const d of pending) {
    if (await mapDecisionNote(d.id)) notesMapped++
    else noteErrors++
  }
  // 2. Rebuild every rule from every decision.
  const result = recomputeRules()
  log(`${result.decisionsUsed} decisions, ${result.specs} rules, ${result.changes.length} changed`)
  // 3. Ask what the pipeline needs to know and the knowledge base does not say.
  const asked = askDailyQuestions()
  // 4. Rescore open jobs with the new rules, and queue skill judgments older than a related answer
  //    for the next jobs:match.
  const { rescored } = await rescoreJobs('open', 'rule_change')
  const answersApplied = applyAllAnswersToOpenJobs()
  if (answersApplied) log(`${answersApplied} open jobs had requirement statuses updated from your answers`)
  const skillRejudge = queueStaleSkillJudgments()
  log(`${skillRejudge} jobs queued to have their skills judged again after your answers`)
  const activeRules = db.select({ id: learnedRules.id }).from(learnedRules)
    .where(and(eq(learnedRules.active, true), gt(learnedRules.evidenceCount, 0))).all().length
  return {
    decisionsUsed: result.decisionsUsed,
    decisionsSkipped: result.decisionsSkipped,
    rules: result.specs,
    activeRules,
    ruleChanges: result.changes.length,
    notesMapped,
    noteErrors,
    questionsAsked: asked.length,
    rescored,
    skillRejudge,
    answersApplied,
  }
}

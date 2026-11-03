import type { Requirement, ScoreBreakdown, SkillClaimSource } from '#shared/types/pipeline'
import { properSkillName } from './names'
import { capitalize } from './plain-text'
import { isProfileFact, isSoftSkill } from './requirement-kinds'

// The Matched and Missing skill chips a card shows, taken from the job's posting requirements so
// they always agree with the requirement checklist under them: Have and Partly count as matched,
// Missing and Not in profile as missing. A skill claim updates the requirement statuses, so the
// chips follow it at once. The scoring call's own short lists (ScoreBreakdown.skills.matched and
// .missing) are only used for a job whose requirements were never extracted.
// Work authorization, location, and degree lines are never chips (requirement-kinds.ts). Soft
// skills that are not matched are never red Missing chips either: they come back as `soft`, for
// one neutral line, and stay out of the Missing count.

export interface SkillChip {
  /** Short name shown on the chip, cut near 44 characters ("Browser behavior, responsive design…"). */
  label: string
  /** The whole name with only the lead words removed, never cut ("Browser behavior, responsive design, accessibility, caching, and web performance"). */
  name: string
  /** The full requirement text (or the score's chip text), for a tooltip and for the skill panel. */
  text: string
  status: Requirement['status'] | null
  mustHave: boolean
  /** What the skill panel is told the tapped text is. */
  source: SkillClaimSource
}

export interface SkillSets {
  matched: SkillChip[]
  missing: SkillChip[]
  /** Soft skills and traits that are not matched. Never counted as Missing. */
  soft: SkillChip[]
  /** False when the chips fell back to the score's lists (no requirements on the job). */
  fromRequirements: boolean
}

const MATCHED: ReadonlySet<Requirement['status']> = new Set(['have', 'partial'])
/** Missing chips: must-haves first, then Missing before Not in profile. */
const MISSING_ORDER: Record<Requirement['status'], number> = { lack: 0, unknown: 1, partial: 2, have: 3 }
/** Matched chips: must-haves first, then Have before Partly. */
const MATCHED_ORDER: Record<Requirement['status'], number> = { have: 0, partial: 1, lack: 2, unknown: 3 }

const LEAD = [
  /^(?:nice to have|nice-to-have|bonus|preferred|plus|a plus)\s*:\s*/i,
  /^(?:an?\s+)?(?:excellent|strong|solid|deep|good|great|proven|practical|hands-on|working(?=\s+(?:knowledge|understanding|familiarity|experience|proficiency))|advanced|basic|exceptional|expert|extensive|demonstrated|significant|professional|real-world|clear)\s+/i,
  /^(?:a\s+)?(?:(?:proven|strong|demonstrated|successful)\s+)?(?:track\s+)?(?:record|history)\s+of\s+(?:successful\s+)?/i,
  /^(?:knowledge|understanding|experience|proficiency|familiarity|fluency|expertise|background|interest)\s+(?:of|in|with|on)\s+/i,
  /^(?:experience|background)\s+(?=[a-z]+ing\b)/i,
  /^(?:the\s+)?ability\s+to\s+/i,
  /^(?:comfort|comfortable)\s+(?:with\s+)?/i,
]

/** Where a long requirement can be cut and still name its subject. */
const CUT = /\s+(?:such as|including|e\.g\.|for example|where|that|which|in order to|to drive|to help|helping|with the ability|while)\s+|,\s+(?:including|with|and the|helping|while)\s+|\s+\(/i

const MAX_LABEL = 44

/** The requirement without its lead words ("Strong understanding of", "Experience with"), whole. */
function stripLead(text: string): string {
  let t = text.replace(/\s+/g, ' ').trim()
  for (let i = 0; i < 4; i++) {
    const before = t
    for (const re of LEAD) t = t.replace(re, '')
    if (t === before) break
  }
  return t
}

/** A closing period goes, unless it ends an abbreviation ("in the U.S."). */
function dropEndPunctuation(t: string): string {
  return t.replace(/(?<!\b[A-Z])[.,;:]+$/, '').trim()
}

/** A posting requirement as a chip name: "Strong understanding of browser behavior, ..." reads "Browser behavior, ...", cut near 44 characters. */
export function requirementLabel(text: string): string {
  let t = stripLead(text)
  if (t.length > MAX_LABEL) {
    const m = CUT.exec(t)
    if (m && m.index >= 12) t = t.slice(0, m.index)
  }
  t = dropEndPunctuation(t)
  if (t.length > MAX_LABEL) {
    const cut = t.lastIndexOf(' ', MAX_LABEL - 1)
    t = `${t.slice(0, cut > 20 ? cut : MAX_LABEL - 1).replace(/[\s,;:]+(?:and|or|of|in|with|the|a|an|to|for)?$/i, '').replace(/[,;:]+$/, '')}…`
  }
  return properSkillName(capitalize(t.length >= 2 ? t : text.trim()))
}

/** A posting requirement as a whole chip name: the lead words go, nothing is cut, and there is never an ellipsis. */
export function requirementName(text: string): string {
  const t = dropEndPunctuation(stripLead(text))
  return properSkillName(capitalize(t.length >= 2 ? t : text.trim()))
}

function fromScore(list: string[]): SkillChip[] {
  return list.filter(s => !isProfileFact(s)).map(s => ({ label: s, name: s, text: s, status: null, mustHave: false, source: 'missing' }))
}

/** The card's Matched and Missing chips. Requirements decide; the score's lists only fill in when there are none. */
export function skillSets(requirements: Requirement[] | null | undefined, score: ScoreBreakdown | null | undefined): SkillSets {
  const reqs = (requirements ?? []).filter(r => !isProfileFact(r.text))
  if (!(requirements ?? []).length) {
    const missing = fromScore(score?.skills.missing ?? [])
    return {
      matched: fromScore(score?.skills.matched ?? []),
      missing: missing.filter(c => !isSoftSkill(c.text)),
      soft: missing.filter(c => isSoftSkill(c.text)),
      fromRequirements: false,
    }
  }
  const chip = (r: Requirement): SkillChip => ({ label: requirementLabel(r.text), name: requirementName(r.text), text: r.text, status: r.status, mustHave: r.mustHave, source: 'requirement' })
  const byMust = (a: Requirement, b: Requirement) => Number(b.mustHave) - Number(a.mustHave)
  const matched = reqs.filter(r => MATCHED.has(r.status))
    .sort((a, b) => byMust(a, b) || MATCHED_ORDER[a.status] - MATCHED_ORDER[b.status])
    .map(chip)
  const unmatched = reqs.filter(r => !MATCHED.has(r.status))
    .sort((a, b) => byMust(a, b) || MISSING_ORDER[a.status] - MISSING_ORDER[b.status])
  return {
    matched,
    missing: unmatched.filter(r => !isSoftSkill(r.text)).map(chip),
    soft: unmatched.filter(r => isSoftSkill(r.text)).map(chip),
    fromRequirements: true,
  }
}

/** Loose comparison key for a skill name or a question subject: lowercase words, no asides. */
export function skillMatchKey(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/\s*\([^)]*\)/g, ' ').replace(/[^a-z0-9+#.]+/g, ' ').trim()
}

/** The open questions that ask about one of these chips (subject inside the chip's name or the other way round). */
export function questionsAbout<Q extends { subject: string | null }>(chips: SkillChip[], questions: Q[]): Q[] {
  const keys = chips.map(c => skillMatchKey(c.name)).filter(k => k.length >= 3)
  return questions.filter((q) => {
    const k = skillMatchKey(q.subject)
    return k.length >= 3 && keys.some(x => x.includes(k) || k.includes(x))
  })
}

/** "3 soft skills" or "1 soft skill", for the neutral line under the Missing chips. */
export function softSkillsCount(n: number): string {
  return `${n} soft ${n === 1 ? 'skill' : 'skills'}`
}

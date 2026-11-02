import type { GapAnalysis } from '#shared/types/pipeline'
import { fixPlurals } from '#shared/utils/plain-text'
import { loadKnowledge } from '../knowledge'

// Gap analyses stored by older runs, and the rationale Claude writes, carry internal text:
// "9 gap(s)", "waiting on Devin", "(kind: skill, nice to have)", and knowledge base references
// such as "skill/Laravel" or "experience/Applied Imagination". This turns them into plain words
// for the demo detail page. References are matched against the real knowledge base keys, so a
// key with spaces ("Mihlfeld and Associates") is replaced whole.

/** The word that follows the name: "your Laravel entry", "your Applied Imagination role". */
const NOUN: Record<string, string> = {
  skill: 'entry',
  experience: 'role',
  project: 'project',
  education: 'entry',
  profile: 'entry',
  preference: 'answer',
  personal: 'answer',
}
const CATEGORIES = Object.keys(NOUN).join('|')
/** A noun Claude already wrote after the reference, dropped so it is not said twice. */
const TRAILING_NOUN = '(?:\\s+(?:entry|role|project|answer)\\b)?'
/** "the skill/TypeScript entry" and "his skill/Vue.js" become "your TypeScript entry", not "the your". */
const LEADING_WORD = '(?<pre>\\b(?:the|his|her)\\s+)?'

interface Reference {
  category: string
  /** What Claude may have written after the slash. */
  name: string
  /** What the page says instead. */
  label: string
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Every knowledge key, plus the company part of "Company - Title" experience keys, longest first. */
function knowledgeReferences(): Reference[] {
  const refs: Reference[] = []
  for (const entry of loadKnowledge()) {
    const category = entry.category.toLowerCase()
    if (!NOUN[category]) continue
    const key = entry.key.trim()
    const short = key.split(/\s+-\s+/)[0]!.trim()
    for (const name of new Set([key, short])) refs.push({ category, name, label: short })
  }
  return refs.sort((a, b) => b.name.length - a.name.length)
}

/** "Your" at the start of a sentence or after a capitalized "The", "your" anywhere else. */
function your(pre: string | undefined, whole: string, offset: number): string {
  // A sentence can end inside a quote: 'over 1000%." skill/Node.js adds' starts a new one.
  const capital = pre ? /^[A-Z]/.test(pre) : offset === 0 || /[.!?]["')\]]*\s+$/.test(whole.slice(Math.max(0, offset - 8), offset))
  return capital ? 'Your' : 'your'
}

export function plainGapText(text: string, refs: Reference[]): string {
  if (!text) return text
  let out = text
  for (const r of refs) {
    const re = new RegExp(`${LEADING_WORD}\\b${r.category}s?/${escapeRegExp(r.name)}(?![A-Za-z0-9])${TRAILING_NOUN}`, 'gi')
    out = out.replace(re, (...args: any[]) => {
      const groups = args[args.length - 1] as { pre?: string }
      return `${your(groups.pre, args[args.length - 2], args[args.length - 3])} ${r.label} ${NOUN[r.category]}`
    })
  }
  // A key the knowledge base no longer has: take one word after the slash.
  out = out.replace(
    new RegExp(`${LEADING_WORD}\\b(?<cat>${CATEGORIES})s?/(?<key>[A-Za-z0-9+#](?:[A-Za-z0-9.+#_-]*[A-Za-z0-9+#])?)${TRAILING_NOUN}`, 'gi'),
    (...args: any[]) => {
      const groups = args[args.length - 1] as { pre?: string; cat: string; key: string }
      return `${your(groups.pre, args[args.length - 2], args[args.length - 3])} ${groups.key} ${NOUN[groups.cat.toLowerCase()]}`
    },
  )
  out = out
    .replace(/\s*\(kind: [^)]*\)/gi, '')
    .replace(/\bwaiting on Devin\b/g, 'waiting on you')
    .replace(/\bwhether Devin has\b/g, 'whether you have')
    .replace(/\bDevin answered\b/g, 'You answered')
  return fixPlurals(out)
}

/** The gap analysis with every displayed string in plain words. */
export function plainGap(gap: GapAnalysis): GapAnalysis {
  const refs = knowledgeReferences()
  const plain = (text: string) => plainGapText(text, refs)
  return {
    ...gap,
    summary: plain(gap.summary),
    items: gap.items.map(item => ({
      ...item,
      requirement: plain(item.requirement),
      rationale: plain(plainOverrideRationale(item.rationale, item.requirement)),
      demoIdea: item.demoIdea ? { ...item.demoIdea, summary: plain(item.demoIdea.summary) } : item.demoIdea,
    })),
  }
}

// ── Demo decisions the code overrode ──
//
// Claude can recommend a demo that a hard rule then refuses: no toolchain on the build server,
// a project in another language than the gap, too many hours, no project idea, or a second demo
// for the same application. The row then says so in one sentence of its own. Older rows appended
// Claude's recommendation after the code's sentence ("...does not have. A small Rails project
// would demonstrate..."), which read as if the demo were still planned; plainOverrideRationale
// rewrites those for display.

/** Toolchain ids from primaryLanguage() as language names. */
const TOOLCHAIN_NAMES: Record<string, string> = {
  go: 'Go', typescript: 'TypeScript', javascript: 'JavaScript', python: 'Python', rust: 'Rust', java: 'Java', php: 'PHP',
}

/** What a requirement or stack names, for languages primaryLanguage() files under "other": Rails is a Ruby demo. */
const NAMED: Array<{ re: RegExp; subject: string; language: string }> = [
  { re: /\bruby on rails\b|\brails\b/i, subject: 'Rails', language: 'Ruby' },
  { re: /\bruby\b/i, subject: 'Ruby', language: 'Ruby' },
  { re: /\bc#|\basp\.net\b|\.net\b|\bdotnet\b/i, subject: '.NET', language: 'C#' },
  { re: /\bswift(?:ui)?\b/i, subject: 'Swift', language: 'Swift' },
  { re: /\bkotlin\b/i, subject: 'Kotlin', language: 'Kotlin' },
  { re: /\belixir\b|\bphoenix\b/i, subject: 'Elixir', language: 'Elixir' },
  { re: /\bscala\b/i, subject: 'Scala', language: 'Scala' },
  { re: /\bc\+\+/i, subject: 'C++', language: 'C++' },
  { re: /\bclojure\b/i, subject: 'Clojure', language: 'Clojure' },
  { re: /\bflutter\b/i, subject: 'Flutter', language: 'Dart' },
  { re: /\bdart\b/i, subject: 'Dart', language: 'Dart' },
  { re: /\bhaskell\b/i, subject: 'Haskell', language: 'Haskell' },
  { re: /\bperl\b/i, subject: 'Perl', language: 'Perl' },
  { re: /\bpython\b|\bdjango\b|\bfastapi\b/i, subject: 'Python', language: 'Python' },
  { re: /\brust\b/i, subject: 'Rust', language: 'Rust' },
  { re: /\bgolang\b|\bGo\b/, subject: 'Go', language: 'Go' },
  { re: /\bjava\b/i, subject: 'Java', language: 'Java' },
  { re: /\bphp\b|\blaravel\b/i, subject: 'PHP', language: 'PHP' },
]

function named(texts: Array<string | null | undefined>) {
  const text = texts.filter(Boolean).join(' ')
  return NAMED.find(n => n.re.test(text)) ?? null
}

/** The language a demo would be written in, by name: the toolchain id when it is one, else what the subject or stack names. */
export function demoLanguageName(lang: string, texts: Array<string | null | undefined>): string | null {
  return TOOLCHAIN_NAMES[lang] ?? named(texts)?.language ?? null
}

/** "A Ruby on Rails demo", "An Elixir demo", "A demo for Kubernetes in production", or "A demo". */
function aDemo(subject: string | null | undefined): string {
  const s = subject?.trim()
  if (!s) return 'A demo'
  if (s.split(/\s+/).length > 3 || /[,;]/.test(s)) return `A demo for ${s}`
  // "An" before a vowel sound: "an Elixir", "an LLM", "an SQL"; but "a Unity", "a user".
  const an = (/^[aeiou]/i.test(s) && !/^(?:u[bcfhjkqrstn][aeiou]|uni|use|eu|one)/i.test(s)) || /^[FHLMNRSX](?:[A-Z0-9]|$)/.test(s)
  return `${an ? 'An' : 'A'} ${s} demo`
}

export function noToolchainSentence(subject: string | null | undefined, language: string | null | undefined): string {
  return `${aDemo(subject)} was considered, but the build server has no ${language ? `${language} toolchain` : 'toolchain for it'}, so none is planned.`
}

export function wrongLanguageSentence(subject: string | null | undefined, language: string | null | undefined): string {
  return `${aDemo(subject)} was considered, but the project idea was written in ${language ?? 'another language'}, which would not show ${subject?.trim() || 'the skill'}, so none is planned.`
}

export function tooLargeSentence(subject: string | null | undefined, hours: number | string): string {
  return `${aDemo(subject)} was considered, but the project idea needs about ${hours} hours, more than a small demo should take, so none is planned.`
}

export function noIdeaSentence(subject: string | null | undefined): string {
  return `${aDemo(subject)} was recommended, but no project idea came back, so none is planned.`
}

export function oneDemoSentence(subject: string | null | undefined, chosen: string | null | undefined): string {
  return `${aDemo(subject)} was considered, but only one demo is built per application${chosen ? `, and ${chosen} was chosen instead` : ''}.`
}

/**
 * A stored rationale written by the older override code, as the one sentence that code now
 * writes. The subject is read from the requirement ("Knowledge of Ruby on Rails" is a Rails
 * demo). Any other rationale comes back unchanged.
 */
export function plainOverrideRationale(rationale: string, requirement: string): string {
  const r = rationale.trim()
  const n = named([requirement])
  let m = /^A demo would need (?:a toolchain|the (\w+) toolchain), which the build server does not have\./.exec(r)
  if (m) return noToolchainSentence(n?.subject, demoLanguageName(m[1] ?? 'other', [requirement]))
  m = /^The gap is (.+?), but the project idea is written in (\w+), so it would not show the skill\./.exec(r)
  if (m) return wrongLanguageSentence(m[1], TOOLCHAIN_NAMES[m[2]!] ?? m[2])
  m = /^The project idea needs about ([\d.]+) hours, too large for a small credible demo\./.exec(r)
  if (m) return tooLargeSentence(n?.subject, m[1]!)
  if (/\bNo project idea came back, so no demo is planned\.$/.test(r)) return noIdeaSentence(n?.subject)
  m = /^Only one demo is built per application; "(.*?)" was chosen instead\./.exec(r)
  if (m) return oneDemoSentence(n?.subject, m[1] || null)
  return rationale
}

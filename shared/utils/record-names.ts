// Answer text never names a client, a repo, or a GitHub organization, and never says "repo".
// It describes the project instead ("car wash management software", "a telehealth application",
// "an algorithmic trading engine I built on my own"). Employers on Devin's resume are fine.
// This file is pure (no database), so it can be checked against stored text with a script;
// server/utils/repos/describe.ts feeds it repo_sources, the stored descriptions, and the
// knowledge base, and every writer of answer text calls it there.

export interface RecordName {
  /** Spellings to find: "WashWerk", "potomac floral", "dev-applied/levelup". */
  variants: string[]
  /** What the text says instead. Reads after "in" or "on": "car wash management software". */
  description: string
  /** An owner or organization: in "owner/name" its stand-in goes with the slash. */
  owner?: boolean
}

/** One repo as the name list needs it. */
export interface NameSource {
  fullName: string
  owner: string
  name: string
  ownerType: string | null
  /** Switched on in Settings: his own work or a client's he chose to count. */
  included: boolean
  /** Owned by one of his own logins. */
  personal: boolean
  description: string | null
}

export interface NameContext {
  /** The knowledge base, lowercased: a word it uses is a tool he knows, not a name ("sentry"). */
  kbText: string
  /** Employers on his resume ("Applied Imagination"), which answer text may name. */
  employers: string[]
  /** His own GitHub logins, never treated as a client. */
  logins: string[]
}

/** Repo and owner words too common to treat as a name ("docs", "api", "website"). */
const GENERIC = new Set([
  'test', 'tests', 'testing', 'web', 'app', 'apps', 'api', 'internal', 'design', 'poc', 'skills', 'site', 'sites', 'docs',
  'demo', 'demos', 'server', 'client', 'admin', 'portal', 'mobile', 'backend', 'frontend', 'core', 'tools', 'main', 'master',
  'dev', 'prod', 'staging', 'config', 'setup', 'template', 'templates', 'project', 'projects', 'service', 'services', 'data',
  'scripts', 'infra', 'deploy', 'action', 'actions', 'plugin', 'plugins', 'theme', 'website', 'monitoring', 'dashboard',
  'laravel', 'vue', 'nuxt', 'react', 'node', 'docker', 'autofix', 'sentry', 'github', 'resume', 'notes', 'sandbox', 'playground',
  'example', 'examples', 'starter', 'boilerplate', 'library', 'package', 'packages', 'shared', 'common', 'utils', 'cli',
])

/** Suffixes that name a part of a project, not the project ("latina.web", "levelup-api"). */
export const PART_SUFFIX = /[-_.](?:web|api|app|ui|frontend|backend|server|client|site|admin|mobile|ios|android|js|v\d+)$/i

export function nameWords(s: string): string[] {
  return s.split(/[\s_.-]+/).filter(Boolean)
}

/** "WashWerk" -> "Wash Werk", so a split spelling matches too. */
export function splitCamel(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, '$1 $2')
}

/**
 * Spellings of one repo or owner name worth replacing. A one-word spelling counts only when it is
 * not a common word: it holds a digit or mixed case ("WashWerk"), or it has five or more letters
 * and neither the knowledge base nor a stoplist uses it ("sentry" is a tool he knows, "visilaunch" a
 * client). Phrases ("southern mechanical", "potomac floral") always count.
 */
export function nameSpellings(raw: string, ctx: NameContext, opts: { prefixes?: boolean } = {}): string[] {
  const out = new Set<string>()
  const logins = new Set(ctx.logins.map(l => l.toLowerCase()))
  const add = (v: string) => {
    const t = v.trim()
    if (t.length < 3) return
    const lower = t.toLowerCase()
    if (logins.has(lower.replace(/\s+/g, ''))) return
    if (ctx.employers.some(e => e.toLowerCase() === lower)) return
    const parts = nameWords(t)
    if (parts.length >= 2) {
      if (parts.every(p => GENERIC.has(p.toLowerCase()))) return
      out.add(t)
      return
    }
    if (GENERIC.has(lower)) return
    const known = new RegExp(`(^|[^a-z0-9])${lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(ctx.kbText)
    if (/\d/.test(t) || /[a-z][A-Z]/.test(t) || (t.length >= 5 && !known)) out.add(t)
  }
  // "dialectic-mind-guide-0dbb11b0" is also written without its hash.
  const unhashed = raw.replace(/[-_][0-9a-f]{6,}$/i, '')
  const base = unhashed.replace(PART_SUFFIX, '')
  for (const v of [...new Set([raw, unhashed, base])]) {
    add(v)
    add(nameWords(v).join(' '))
    add(splitCamel(v))
    add(nameWords(v).join(''))
    // An organization's first two words ("Potomac Floral" of Potomac-Floral-Wholesale). Never for a
    // repo: "coin base" of coin-base-trader would read the exchange Coinbase as his project.
    const w = nameWords(splitCamel(v))
    if (opts.prefixes && w.length >= 3) add(w.slice(0, 2).join(' '))
  }
  return [...out]
}

/** A plain stand-in when a repo has no description yet. */
export function fallbackDescription(personal: boolean): string {
  return personal ? 'a project of my own' : 'a client project'
}

/**
 * Every name worth replacing, with what answer text says instead. Repos count when switched on or
 * owned by an organization (a client's or employer's); a repo of his own that is off is usually a
 * copy of a public library ("coinbase-pro-node"), whose name is a public product, not a client.
 * An organization reads as the employer it belongs to ("dev-applied" is Applied Imagination) or as
 * "a client".
 */
export function buildRecordNames(rows: NameSource[], ctx: NameContext): RecordName[] {
  const out: RecordName[] = []
  const owners = new Map<string, NameSource>()
  for (const r of rows) {
    const org = !r.personal
    if (!r.included && !org) continue
    const description = r.description || fallbackDescription(r.personal)
    const variants = [r.fullName, ...nameSpellings(r.name, ctx)]
    out.push({ variants, description })
    if (org && !owners.has(r.owner)) owners.set(r.owner, r)
  }
  for (const owner of owners.keys()) {
    const ownerWords = nameWords(owner).map(w => w.toLowerCase()).filter(w => w.length >= 5)
    const employer = ctx.employers.find(e => ownerWords.some(w => e.toLowerCase().split(/\s+/).includes(w)))
    const variants = nameSpellings(owner, ctx, { prefixes: true })
    if (variants.length) out.push({ variants, description: employer ?? 'a client', owner: true })
  }
  return out
}

const ARTICLE = String.raw`(?:\b(?:the|a|an|our|my|his)\s+)?`
/** Nouns that follow a name and that the description already covers ("the WashWerk repo"). */
const TRAILING = String.raw`(?:\s+(?:repo|repos|repository|repositories|codebase|code base|project|app|application|platform|site|website|product|system))?`
/** The rest of an identifier the name starts ("dialectic-mind" in "dialectic-mind-guide-0dbb11b0"). */
const TAIL = String.raw`(?:[-_.][A-Za-z0-9]+)*`

/** Description words that do not echo a name ("built", "client"). */
const DESCRIPTION_STOP = new Set(['built', 'with', 'from', 'that', 'this', 'client', 'clients', 'own', 'mine', 'their', 'for'])

function escapeVariant(v: string): string {
  return v.trim().split(/[\s_.-]+/).filter(Boolean)
    .map(p => p.replace(/[.*+?^${}()|[\]\\]/g, m => `\\${m}`))
    .join(String.raw`[\s_.-]?`)
}

/**
 * The text with every record name replaced by its description: a preceding article, the rest of
 * the identifier, and a following "repo", "project", or "app" go with the name, since the
 * description carries its own. The same description twice in a row ("X and X") reads once. Then
 * any "repo" left is "project". Matching is case-insensitive on whole words.
 */
export function vagueText(text: string, names: RecordName[]): { text: string; replaced: string[] } {
  if (!text) return { text, replaced: [] }
  const all = names.flatMap(n => n.variants.filter(v => v.trim().length >= 3).map(v => ({ v, d: n.description, owner: !!n.owner })))
    .sort((a, b) => b.v.length - a.v.length)
  let out = text
  const replaced = new Set<string>()
  const used = new Set<string>()
  const ownerStandIns = new Set<string>()
  for (const { v, d, owner } of all) {
    if (owner) ownerStandIns.add(d)
    // Words after the name that the description already says ("touchstone trading engine" when the
    // description is "an algorithmic trading engine I built on my own") go with the name too.
    const own = [...new Set(d.toLowerCase().match(/[a-z]{4,}/g) ?? [])].filter(w => !DESCRIPTION_STOP.has(w))
    const echo = own.length ? `(?:\\s+(?:${own.join('|')})){0,3}` : ''
    const re = new RegExp(`${ARTICLE}(?<![A-Za-z0-9])${escapeVariant(v)}${TAIL}(?![A-Za-z0-9])(?:['’]s)?${echo}${TRAILING}`, 'gi')
    out = out.replace(re, (m, offset: number, whole: string) => {
      replaced.add(v)
      used.add(d)
      // A capital at the start of a sentence stays a capital.
      const atStart = offset === 0 || /[.!?]\s+$/.test(whole.slice(0, offset))
      return atStart ? d.charAt(0).toUpperCase() + d.slice(1) : d
    })
  }
  // "a client/a telehealth application": the owner's stand-in before a slash goes.
  for (const d of ownerStandIns) {
    const e = d.replace(/[.*+?^${}()|[\]\\]/g, m => `\\${m}`)
    out = out.replace(new RegExp(`(?<![A-Za-z0-9])${e}\\s*/\\s*(?=\\S)`, 'gi'), '')
  }
  for (const d of used) {
    const e = d.replace(/[.*+?^${}()|[\]\\]/g, m => `\\${m}`)
    out = out.replace(new RegExp(`(${e})(?:(?:,?\\s+and\\s+|,\\s*|\\s*/\\s*)${e})+`, 'gi'), '$1')
  }
  out = out
    .replace(/\brepositories\b/gi, m => (m[0] === 'R' ? 'Projects' : 'projects'))
    .replace(/\brepository\b/gi, m => (m[0] === 'R' ? 'Project' : 'project'))
    .replace(/\brepos\b/gi, m => (m[0] === 'R' ? 'Projects' : 'projects'))
    .replace(/\brepo\b/gi, m => (m[0] === 'R' ? 'Project' : 'project'))
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,;:!?])/g, '$1')
    .replace(/[ \t]+\.(?=\s|$)/g, '.')
  return { text: out, replaced: [...replaced] }
}

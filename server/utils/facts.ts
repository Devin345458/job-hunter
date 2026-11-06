// Personal facts that application forms ask for: which form labels ask for each one, where the
// knowledge base stores it, and how the value is derived from what is already stored. Initials
// come from the full name, city and state from the home address, the one-line address from its
// parts, and the country from a US state. Nothing is ever invented: a fact with no stored source
// resolves to null and the pipeline asks for it.
//
// Pure functions only (no database, no Nitro auto-imports), so the label matching and the
// derivations can be checked with tsx on their own. answers.ts and questions.ts do the I/O.

import type { CompensationBreakdown } from '#shared/types/pipeline'
import { compParts } from '#shared/utils/comp-parts'

// ── Shapes ───────────────────────────────────────────────────

/** The fields of a knowledge base row this module reads. */
export interface FactEntry {
  category: string
  key: string
  value: string
  source?: string | null
}

export type FactGroup = 'name' | 'address' | 'contact' | 'work'

export type FactKey =
  | 'name.full' | 'name.first' | 'name.last' | 'name.preferred' | 'name.initials' | 'name.middle_initial' | 'name.signature'
  | 'address.street' | 'address.line2' | 'address.city' | 'address.state' | 'address.zip' | 'address.country'
  | 'address.full' | 'address.location' | 'address.city_country' | 'address.city_state_country' | 'address.city_state_zip'
  | 'address.us_resident' | 'address.timezone' | 'address.location_judgment'
  | 'contact.email' | 'contact.phone' | 'contact.linkedin' | 'contact.github' | 'contact.github_username' | 'contact.website'
  | 'work.sponsorship' | 'work.authorization' | 'work.relocation' | 'work.start_date' | 'work.salary' | 'work.salary_in_band'

/** One resolved value and where it came from, e.g. "profile/Full Name" or "initials of profile/Full Name". */
export interface FactValue {
  value: string
  detail: string
  /** True when the value was computed from other stored facts rather than stored as written. */
  derived: boolean
}

export type FactValues = Partial<Record<FactKey, FactValue>>

export type AddressPart = 'street' | 'city' | 'state' | 'zip'

export const ADDRESS_PARTS: AddressPart[] = ['street', 'city', 'state', 'zip']

/** What to ask when a fact cannot be resolved. Facts that share a question share its subject. */
export interface FactQuestion {
  kind: 'fact' | 'preference'
  /** Fixed subject, so the question dedupes across every application and every ATS. */
  subject: string
  question: string
  knowledgeKey: string
  answerType: 'yes_no' | 'text'
  category: 'technical' | 'preference'
}

export interface FactDef {
  key: FactKey
  group: FactGroup
  /** Plain name used in notes, e.g. "initials" or "city and state". */
  label: string
  /** Tested against the normalized label (lowercase, "&" as "and", punctuation as spaces). */
  match?: RegExp
  /** Tested against the label exactly as the form shows it. The work facts kept their original patterns. */
  matchRaw?: RegExp
  /** Input types that are this fact whatever the label says (an email input is the email address). */
  types?: string[]
  /** Labels that look like this fact but are not. */
  exclude?: RegExp
  /** Fields that look like this fact but are not, judged from the fields around them on the form. */
  contextExclude?: (field: FieldLike, siblings: FieldLike[]) => boolean
  /** The value that answers the label as written, or null. */
  value: (v: FactValues) => FactValue | null
  /**
   * The value worded for this field, when one fact reads differently per label: the salary
   * expectation is "$160,000" for "minimum required salary" and "$160,000 or more base" elsewhere,
   * and on a list of pay ranges it is the range that holds the figure. Replaces value() when set.
   * `exact` marks a value already chosen from the field's options (or a plain Yes), so a choice
   * field takes it as it is instead of going to mapToOptions.
   */
  fieldValue?: (field: FieldShape, v: FactValues) => (FactValue & { exact?: boolean }) | null
  /** For choice fields: values to try against the options, in order. Defaults to [value]. */
  choiceValues?: (v: FactValues) => string[]
  /** A sentence for mapToOptions when the label needs judgment on top of the fact (a time zone, a commute). */
  statement?: (v: FactValues) => string | null
  /** Address parts this fact needs. Drives what the single address question asks for. */
  needs?: AddressPart[]
  /** The question asked when the fact is unknown. Null: never asked (left blank instead). */
  ask: FactQuestion | null
  /**
   * Where Devin's own answer to exactly this fact is stored. A question the tidy answers by
   * derivation points here, so answering it again overrides the derivation ("DH" instead of
   * "DHG" goes to profile:Initials, never to profile:Full Name).
   */
  storeKey?: string
  /** The work facts block approval even on optional fields. */
  alwaysBlocking: boolean
  /** Lower confidence, e.g. the preferred name defaulting to the first name. */
  confidence?: 'high' | 'medium'
}

// ── Text helpers ─────────────────────────────────────────────

/** "What city & state do you live in?" becomes "what city and state do you live in". */
export function labelText(label: string): string {
  return label
    .toLowerCase()
    .replace(/[✱*]/g, '')
    .replace(/&/g, ' and ')
    .replace(/e-mail/g, 'email')
    .replace(/[^a-z0-9+#]+/g, ' ')
    .trim()
}

function normKey(category: string, key: string) {
  return `${category} ${key}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/**
 * The learning unit stores a yes/no answer as "Yes. (Answer to: <question>)". Forms need the
 * answer itself, so the suffix and the lone period go.
 */
export function cleanStoredAnswer(value: string): string {
  return value
    .replace(/\s*\(Answer to:[\s\S]*\)\s*$/i, '')
    .replace(/^(yes|no|some experience)\.$/i, '$1')
    .trim()
}

/**
 * A stored "none" means Devin said he has none: known, but nothing to fill. "No" counts only for
 * a URL or handle; for a yes/no fact such as sponsorship it is the answer itself.
 */
function isNone(value: string, noMeansNone = false) {
  return /^(none|n\/a|na)$/i.test(value.trim()) || (noMeansNone && /^no\.?$/i.test(value.trim()))
}

// ── US states ────────────────────────────────────────────────

export const US_STATES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas',
  KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts',
  MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico',
  NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', PR: 'Puerto Rico', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
}

const STATE_BY_NAME = new Map(Object.entries(US_STATES).map(([code, name]) => [name.toLowerCase(), code]))
// Longest names first, so "West Virginia" wins over "Virginia".
const STATE_NAMES = [...STATE_BY_NAME.keys()].sort((a, b) => b.length - a.length)

/** "mo", "MO", "Missouri" and "missouri" all give "MO". Null for anything that is not a US state. */
export function stateCode(text: string): string | null {
  const t = text.trim().replace(/\.$/, '')
  if (/^[a-z]{2}$/i.test(t) && US_STATES[t.toUpperCase()]) return t.toUpperCase()
  return STATE_BY_NAME.get(t.toLowerCase()) ?? null
}

// ── Address parsing ──────────────────────────────────────────

export interface AddressParts {
  street?: string
  line2?: string
  city?: string
  /** Two-letter code. */
  state?: string
  zip?: string
  country?: string
}

const COUNTRY_TAIL = /(?:,\s*|\s+|^)(u\.?\s?s\.?\s?a\.?|u\.?\s?s\.?|united states(?: of america)?)\s*$/i
const ZIP_TAIL = /(?:,\s*|\s+|^)(\d{5})(?:-(\d{4}))?\s*$/
const LINE2 = /^(apt|apartment|suite|ste|unit|#|bldg|building|floor|fl|room|rm)\b/i

/**
 * Splits a written address into its parts. Conservative: a part is returned only when the text
 * leaves no doubt. "1200 W. Oakmont, Columbus OH 43215" gives street, city, state and ZIP.
 * "1200 W. Oakmont Columbus OH 43215" (no comma between street and city) gives only state
 * and ZIP, because the street cannot be told apart from the city.
 */
export function parseAddress(text: string | null | undefined): AddressParts {
  const out: AddressParts = {}
  if (!text) return out
  let s = text.replace(/\s*\n\s*/g, ', ').replace(/\s+/g, ' ').replace(/[.,;\s]+$/, '').trim()
  if (!s) return out

  const country = s.match(COUNTRY_TAIL)
  if (country && country.index! > 0) {
    out.country = 'United States'
    s = s.slice(0, country.index).replace(/[,\s]+$/, '')
  }

  const zip = s.match(ZIP_TAIL)
  if (zip) {
    out.zip = zip[2] ? `${zip[1]}-${zip[2]}` : zip[1]
    s = s.slice(0, zip.index).replace(/[,\s]+$/, '')
  }

  // The state is the last token: a two-letter code or a full name.
  let stateMatch: { code: string; index: number; viaComma: boolean; raw: string } | null = null
  const lower = s.toLowerCase()
  for (const name of STATE_NAMES) {
    if (lower.endsWith(name) && (lower.length === name.length || /[\s,]/.test(lower[lower.length - name.length - 1]!))) {
      const index = s.length - name.length
      stateMatch = { code: STATE_BY_NAME.get(name)!, index, viaComma: /,\s*$/.test(s.slice(0, index)), raw: s.slice(index) }
      break
    }
  }
  if (!stateMatch) {
    const two = s.match(/(?:^|[\s,])([a-z]{2})\.?$/i)
    if (two && US_STATES[two[1]!.toUpperCase()]) {
      const index = s.length - two[0].replace(/^[\s,]/, '').length
      stateMatch = { code: two[1]!.toUpperCase(), index, viaComma: /,\s*$/.test(s.slice(0, index)), raw: two[1]! }
    }
  }
  if (stateMatch) {
    const rest = s.slice(0, stateMatch.index).replace(/[,\s]+$/, '')
    const restStartsWithNumber = /^\d/.test(rest)
    // "Oakmont Ct" ends in what looks like Connecticut. A state is trusted only when a comma
    // sets it apart, a ZIP follows it, it is the whole text, or it is a capitalized code after a
    // city name ("Columbus OH").
    const isCode = stateMatch.raw.length === 2
    const trusted = stateMatch.viaComma || !!out.zip || !rest
      || (!restStartsWithNumber && (!isCode || stateMatch.raw === stateMatch.raw.toUpperCase()))
    if (trusted) {
      out.state = stateMatch.code
      if (!out.country) out.country = 'United States'
      s = rest
    }
  }

  const segments = s.split(/\s*,\s*/).map(x => x.trim()).filter(Boolean)
  const known = !!(out.state || out.zip)
  if (segments.length === 0) return out
  if (known) {
    if (segments.length >= 2) {
      out.city = segments[segments.length - 1]
      const streetParts = segments.slice(0, -1)
      const line2 = streetParts.length > 1 && LINE2.test(streetParts[streetParts.length - 1]!) ? streetParts.pop() : undefined
      out.street = streetParts.join(', ')
      if (line2) out.line2 = line2
    }
    else if (!/^\d/.test(segments[0]!)) {
      out.city = segments[0]
    }
    // One segment that starts with a number holds the street and the city with no comma
    // between them, and nothing says where one ends. Both stay unknown.
  }
  else if (/^\d/.test(segments[0]!)) {
    if (segments.length === 1) out.street = segments[0]
    else if (segments.length === 2 && LINE2.test(segments[1]!)) {
      out.street = segments[0]
      out.line2 = segments[1]
    }
    else if (segments.length === 2) {
      out.street = segments[0]
      out.city = segments[1]
    }
  }
  if (out.city) out.city = out.city.replace(/\.$/, '')
  return out
}

/** "1200 W. Oakmont, Columbus, OH 43215" from whichever parts are known; null without street, city and state. */
export function formatAddress(p: AddressParts): string | null {
  if (!p.street || !p.city || !p.state) return null
  const street = p.line2 ? `${p.street}, ${p.line2}` : p.street
  return `${street}, ${p.city}, ${p.state}${p.zip ? ` ${p.zip}` : ''}`
}

// ── Names ────────────────────────────────────────────────────

const NAME_SUFFIX = /^(jr|sr|ii|iii|iv|v|phd|md|esq)\.?$/i

function nameTokens(full: string): string[] {
  return full.replace(/\(.*?\)|".*?"/g, ' ').split(/\s+/).map(t => t.replace(/[.,]+$/, '')).filter(t => t && !NAME_SUFFIX.test(t))
}

/** "Devin Hollister-Graham" gives "DHG": the first letter of every name, hyphenated parts included. */
export function initialsOf(full: string): string | null {
  const letters = nameTokens(full).flatMap(t => t.split('-')).map(p => p.match(/[a-z]/i)?.[0]).filter(Boolean) as string[]
  return letters.length >= 2 ? letters.join('').toUpperCase() : null
}

// ── Resolving every fact from the knowledge base ─────────────

/** The kinds a question row can have (AskInput['kind'] in questions.ts). */
export type QuestionKind = 'has_done' | 'knows' | 'preference' | 'fact' | 'form_field' | 'other'

export interface ResolveOptions {
  /** Devin's answer to an already answered question, by (kind, subject). Used after the knowledge base. */
  answered?: (kind: QuestionKind, subject: string) => string | null
  /**
   * The pay the job posts (jobs.comp_json), for the facts that depend on the job: whether his
   * minimum falls within the posted range. Left out, those facts are absent.
   */
  comp?: CompensationBreakdown | null
}

/**
 * The first entry under any of the keys, most specific key first. An entry the tidy inferred
 * (source "inferred") is returned only when no key holds one Devin stated, so an inferred
 * profile:Street Address never hides the personal:Street Address he typed.
 */
function lookup(entries: FactEntry[], keys: string[]): FactEntry | null {
  let inferred: FactEntry | null = null
  for (const want of keys) {
    const [category, key] = want.split('/') as [string, string]
    const target = normKey(category, key)
    for (const e of entries) {
      if (normKey(e.category, e.key) !== target || !e.value.trim()) continue
      if (e.source !== 'inferred') return e
      inferred ??= e
    }
  }
  return inferred
}

const kbDetail = (e: FactEntry) => `${e.category}/${e.key}`

/** Knowledge keys each stored fact may live under, most specific first. */
export const FACT_KB_KEYS = {
  fullName: ['profile/Full Name', 'profile/Legal Name', 'profile/Name'],
  firstName: ['profile/First Name', 'profile/Given Name'],
  lastName: ['profile/Last Name', 'profile/Surname', 'profile/Family Name'],
  middleName: ['profile/Middle Name'],
  preferredName: ['profile/Preferred Name', 'profile/Nickname'],
  initials: ['profile/Initials', 'personal/Initials'],
  street: ['profile/Street Address', 'personal/Street Address', 'profile/Address Line 1', 'personal/Address Line 1'],
  addressWhole: ['profile/Home Address', 'personal/Home Address', 'profile/Address', 'personal/Address', 'profile/Mailing Address', 'personal/Mailing Address'],
  city: ['profile/City', 'personal/City'],
  state: ['profile/State', 'personal/State'],
  zip: ['profile/Zip Code', 'profile/Zip', 'profile/Postal Code', 'personal/Zip Code', 'personal/Postal Code'],
  country: ['profile/Country', 'personal/Country'],
  location: ['profile/Location', 'profile/Current Location', 'personal/Location', 'personal/Current Location'],
  email: ['profile/Email', 'profile/Email Address'],
  phone: ['profile/Phone', 'profile/Phone Number', 'profile/Mobile'],
  linkedin: ['profile/LinkedIn', 'profile/LinkedIn URL'],
  github: ['profile/GitHub', 'profile/GitHub URL', 'profile/GitHub Username'],
  website: ['profile/Website', 'profile/Portfolio', 'profile/Portfolio URL', 'profile/Personal Website'],
}

/** The knowledge entries an answer to the single address question is written to, part by part. */
export const ADDRESS_KNOWLEDGE_KEYS: Record<AddressPart | 'location', string> = {
  location: 'profile:Location',
  street: 'profile:Street Address',
  city: 'profile:City',
  state: 'profile:State',
  zip: 'profile:Zip Code',
}

interface StoredValue {
  value: string
  detail: string
  /** Written by the tidy from other stored text, not stated by Devin. */
  inferred: boolean
}

/** Every fact the knowledge base states or implies. A fact with no stored source is absent. */
export function resolveFacts(entries: FactEntry[], opts: ResolveOptions = {}): FactValues {
  const v: FactValues = {}
  const set = (key: FactKey, value: string | null | undefined, detail: string, derived = false) => {
    if (value && value.trim() && !v[key]) v[key] = { value: value.trim(), detail, derived }
  }
  const stored = (keys: string[]): StoredValue | null => {
    const e = lookup(entries, keys)
    return e ? { value: cleanStoredAnswer(e.value), detail: kbDetail(e), inferred: e.source === 'inferred' } : null
  }

  // Names
  const full = stored(FACT_KB_KEYS.fullName)
  if (full) set('name.full', full.value, full.detail)
  const tokens = full ? nameTokens(full.value) : []
  const first = stored(FACT_KB_KEYS.firstName)
  if (first) set('name.first', first.value, first.detail)
  else if (full && tokens.length >= 2) set('name.first', tokens[0], `first word of ${full.detail}`, true)
  const last = stored(FACT_KB_KEYS.lastName)
  if (last) set('name.last', last.value, last.detail)
  else if (full && tokens.length >= 2) set('name.last', tokens.slice(1).join(' '), `rest of ${full.detail}`, true)
  const preferred = stored(FACT_KB_KEYS.preferredName)
  if (preferred) set('name.preferred', preferred.value, preferred.detail)
  else if (v['name.first']) set('name.preferred', v['name.first'].value, `first name from ${full?.detail ?? v['name.first'].detail}`, true)
  // Initials Devin typed win; then the full name; an entry the tidy inferred only fills a gap.
  const initials = stored(FACT_KB_KEYS.initials)
  if (initials && !initials.inferred) set('name.initials', initials.value, initials.detail)
  else if (full) set('name.initials', initialsOf(full.value), `initials of ${full.detail} (${full.value})`, true)
  if (initials) set('name.initials', initials.value, initials.detail, true)
  const middle = stored(FACT_KB_KEYS.middleName)
  if (middle) set('name.middle_initial', middle.value.charAt(0).toUpperCase(), `first letter of ${middle.detail}`, true)
  else if (full && tokens.length >= 3) set('name.middle_initial', tokens[1]!.charAt(0).toUpperCase(), `middle name in ${full.detail}`, true)
  if (full) set('name.signature', full.value, `${full.detail}, typed as the signature`)

  // Address, in three tiers so every value traces back to something Devin stated:
  // 1. part entries he gave (profile:City, profile:Zip Code);
  // 2. parts parsed out of address text he gave (a street answer that holds the whole address);
  // 3. part entries the tidy inferred from that text (source "inferred"). These only fill gaps, so
  //    a newer street address beats a stale inferred city.
  const parts: AddressParts = {}
  const partDetail: Partial<Record<keyof AddressParts, string>> = {}
  const partDerived: Partial<Record<keyof AddressParts, boolean>> = {}
  const take = (p: keyof AddressParts, value: string | undefined, detail: string, derived: boolean) => {
    if (value && !parts[p]) {
      parts[p] = value
      partDetail[p] = detail
      partDerived[p] = derived
    }
  }
  const cityE = stored(FACT_KB_KEYS.city)
  const stateE = stored(FACT_KB_KEYS.state)
  const zipE = stored(FACT_KB_KEYS.zip)
  const countryE = stored(FACT_KB_KEYS.country)
  const locationE = stored(FACT_KB_KEYS.location)
  const streetE = stored(FACT_KB_KEYS.street)
  const wholeE = stored(FACT_KB_KEYS.addressWhole)
  const explicitParts = (inferred: boolean) => {
    const mine = (e: StoredValue | null): e is StoredValue => !!e && e.inferred === inferred
    if (mine(cityE)) take('city', cityE.value, cityE.detail, inferred)
    if (mine(stateE)) take('state', stateCode(stateE.value) ?? stateE.value, stateE.detail, inferred)
    if (mine(zipE)) take('zip', zipE.value.match(/\d{5}(-\d{4})?/)?.[0] ?? zipE.value, zipE.detail, inferred)
    if (mine(countryE)) take('country', countryE.value, countryE.detail, inferred)
  }
  const parsedParts = (inferred: boolean) => {
    for (const src of [streetE, wholeE, locationE]) {
      if (!src || src.inferred !== inferred) continue
      const p = parseAddress(src.value)
      const from = `parsed from ${src.detail} ("${src.value}")`
      take('street', p.street, from, true)
      take('line2', p.line2, from, true)
      take('city', p.city, from, true)
      take('state', p.state, from, true)
      take('zip', p.zip, from, true)
      take('country', p.country, from, true)
    }
  }
  explicitParts(false)
  parsedParts(false)
  // A stored street with nothing else in it is the street itself.
  if (streetE && !parts.street && /^\d/.test(streetE.value) && !/,/.test(streetE.value)) take('street', streetE.value, streetE.detail, streetE.inferred)
  explicitParts(true)
  parsedParts(true)
  if (!parts.country && parts.state && US_STATES[parts.state]) {
    parts.country = 'United States'
    partDetail.country = `${parts.state} is a US state`
    partDerived.country = true
  }

  if (parts.street) set('address.street', parts.street, partDetail.street!, !!partDerived.street)
  if (parts.line2) set('address.line2', parts.line2, partDetail.line2!, true)
  if (parts.city) set('address.city', parts.city, partDetail.city!, !!partDerived.city)
  if (parts.state) set('address.state', parts.state, partDetail.state!, !!partDerived.state)
  if (parts.zip) set('address.zip', parts.zip, partDetail.zip!, !!partDerived.zip)
  if (parts.country) set('address.country', parts.country, partDetail.country!, !!partDerived.country)
  if (parts.city && parts.state) {
    const from = partDetail.city === partDetail.state ? partDetail.city! : `${partDetail.city}; ${partDetail.state}`
    set('address.location', `${parts.city}, ${parts.state}`, `city and state ${from}`, true)
    if (parts.country) set('address.city_state_country', `${parts.city}, ${parts.state}, ${parts.country}`, `city, state and country ${from}`, true)
    if (parts.zip) set('address.city_state_zip', `${parts.city}, ${parts.state} ${parts.zip}`, `city, state and ZIP ${from}`, true)
  }
  else if (locationE) {
    // A location written some other way ("Remote, Midwest") still answers a location field as written.
    set('address.location', locationE.value, locationE.detail)
  }
  if (parts.city && parts.country) set('address.city_country', `${parts.city}, ${parts.country}`, `city and country ${partDetail.city}`, true)
  const oneLine = formatAddress(parts)
  if (oneLine) set('address.full', oneLine, `home address from ${[...new Set([partDetail.street, partDetail.city, partDetail.state, partDetail.zip].filter(Boolean))].join('; ')}`, true)
  if (parts.country === 'United States') set('address.us_resident', 'Yes', `home address is in ${parts.state ?? 'the United States'}`, true)

  // Contact
  const email = stored(FACT_KB_KEYS.email)
  if (email) set('contact.email', email.value, email.detail)
  const phone = stored(FACT_KB_KEYS.phone)
  if (phone) set('contact.phone', phone.value, phone.detail)
  const linkedin = stored(FACT_KB_KEYS.linkedin) ?? answeredAs(opts, 'fact', 'LinkedIn URL')
  if (linkedin && !isNone(linkedin.value, true)) set('contact.linkedin', linkedin.value, linkedin.detail)
  const github = stored(FACT_KB_KEYS.github)
  if (github) {
    const handle = github.value.replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/^@/, '').replace(/\/+$/, '')
    set('contact.github_username', handle, github.detail)
    set('contact.github', /^https?:\/\//i.test(github.value) ? github.value : `https://github.com/${handle}`, github.detail)
  }
  const website = stored(FACT_KB_KEYS.website)
  if (website && !isNone(website.value, true)) set('contact.website', website.value, website.detail)
  else if (v['contact.github']) set('contact.website', v['contact.github'].value, `${v['contact.github'].detail} (the GitHub profile is the portfolio)`, true)

  // Work facts: knowledge base first, then an answered question. Pay is read below.
  for (const def of WORK_FACTS) {
    if (def.key === 'work.salary' || def.key === 'work.salary_in_band') continue
    const kb = stored(def.kb)
    const value = kb && !isNone(kb.value) ? kb : answeredAs(opts, def.ask!.kind, def.ask!.subject)
    if (value && value.value && !/^none$/i.test(value.value)) set(def.key, value.value, value.detail)
  }

  // Pay. The salary expectation is never below his minimum: the figure is the minimum, or his
  // target when that is higher. Written as "$160,000 or more base"; fieldValue words it per label.
  // Text without a dollar figure (a stray "Yes") is no figure at all.
  const pay = payBasis(entries, opts)
  if (pay.figure) set('work.salary', `${usd(pay.figure.value)} or more base`, pay.figure.detail)
  // Within the posted range: Yes when the top of what the job posts reaches his minimum. Never
  // No: a range under it, or no range, is his call for that one application.
  if (opts.comp !== undefined && pay.floor) {
    const top = postedPayTop(opts.comp)
    if (top && top.top >= pay.floor.value) {
      set('work.salary_in_band', 'Yes', `the posted ${top.basis} pay tops out at ${usd(top.top)}, at or above your minimum of ${usd(pay.floor.value)} (${pay.floor.detail})`, true)
    }
  }
  return v
}

// ── Pay ──────────────────────────────────────────────────────

/** Where his lowest acceptable total pay may be stored, most specific first. */
export const PAY_FLOOR_KB_KEYS = ['preference/Minimum Total Compensation', 'preference/Compensation Floor', 'preference/Salary Floor', 'preference/Minimum Salary', 'preference/Minimum Compensation']
/** Where the salary he aims for may be stored. */
export const PAY_TARGET_KB_KEYS = ['preference/Target Salary', 'preference/Salary Expectation', 'preference/Desired Salary']

/** Subjects of the pay questions: COMP_FLOOR_SUBJECT in questions.ts, and the salary fact's own question. */
const FLOOR_SUBJECT = 'compensation floor'
const TARGET_SUBJECT = 'salary expectation'

function usd(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`
}

const MONEY = /\$?\s?(\d+(?:\.\d+)?)\s?(k\b)?/gi

/** Every figure of $10,000 or more in a text, in order: "$150,000 to $160,000" gives both. */
function payFigures(text: string): number[] {
  const t = text.replace(/(\d),(?=\d{3}\b)/g, '$1')
  return [...t.matchAll(MONEY)]
    .map(m => Number(m[1]) * (m[2] ? 1000 : 1))
    .filter(n => Number.isFinite(n) && n >= 10000)
    .map(n => Math.round(n))
}

/**
 * The first dollar figure in a stored pay answer: "$160,000 a year in total compensation ...",
 * "$150,000+ USD", "160000", "160k". Null with no figure, or none of $10,000 or more.
 */
export function payFigure(text: string | null | undefined): number | null {
  if (!text) return null
  return payFigures(cleanStoredAnswer(text))[0] ?? null
}

export interface PayValue {
  value: number
  /** Where it came from: "preference/Minimum Total Compensation" or "question: compensation floor". */
  detail: string
}

export interface PayBasis {
  /** His lowest acceptable total yearly pay. */
  floor: PayValue | null
  /** The salary he aims for. */
  target: PayValue | null
  /** What a salary field states: the floor, or the target when it is higher. */
  figure: (PayValue & { from: 'floor' | 'target' }) | null
}

/** His minimum and target from the knowledge base, then from answered questions. Nothing is guessed. */
export function payBasis(entries: FactEntry[], opts: ResolveOptions = {}): PayBasis {
  const read = (keys: string[], subject: string): PayValue | null => {
    for (const want of keys) {
      const e = lookup(entries, [want])
      const n = e ? payFigure(e.value) : null
      if (e && n != null) return { value: n, detail: kbDetail(e) }
    }
    const n = payFigure(opts.answered?.('preference', subject))
    return n != null ? { value: n, detail: `question: ${subject}` } : null
  }
  const floor = read(PAY_FLOOR_KB_KEYS, FLOOR_SUBJECT)
  const target = read(PAY_TARGET_KB_KEYS, TARGET_SUBJECT)
  const figure = target && (!floor || target.value > floor.value)
    ? { ...target, from: 'target' as const }
    : floor ? { ...floor, from: 'floor' as const } : null
  return { floor, target, figure }
}

/**
 * The top of what a job posts, in yearly US dollars: the total when the posting adds anything to
 * base (a bonus, equity, a valued benefit), else base. Read from compParts(), the one pay sum. Null
 * with no base pay, or pay in another currency.
 */
export function postedPayTop(comp: CompensationBreakdown | null | undefined): { top: number; basis: 'base' | 'total' } | null {
  if (!comp || (comp.currency ?? 'USD').toUpperCase() !== 'USD') return null
  const parts = compParts(comp)
  if (parts.totalMax == null) return null
  return { top: parts.totalMax, basis: parts.counted.length ? 'total' : 'base' }
}

/** "$165,000 to $225,000 base" or "$163,280 to $221,520 total", for a sentence. Null with no base pay or another currency. */
export function postedPayText(comp: CompensationBreakdown | null | undefined): string | null {
  if (!comp || (comp.currency ?? 'USD').toUpperCase() !== 'USD') return null
  const parts = compParts(comp)
  if (parts.totalMin == null || parts.totalMax == null) return null
  const basis = parts.counted.length ? 'total' : 'base'
  return parts.totalMin === parts.totalMax ? `${usd(parts.totalMax)} ${basis}` : `${usd(parts.totalMin)} to ${usd(parts.totalMax)} ${basis}`
}

/** One option of a pay range list: "$150,000 to $160,000", "$200,000+", "Under $100k". Null when it states no figure. */
export function optionRange(option: string): { low: number; high: number } | null {
  const nums = payFigures(option)
  if (nums.length === 0) return null
  if (nums.length === 1) {
    if (/\b(under|less than|below|up to|max|maximum)\b|</i.test(option)) return { low: 0, high: nums[0]! }
    return { low: nums[0]!, high: Infinity }
  }
  return { low: Math.min(nums[0]!, nums[1]!), high: Math.max(nums[0]!, nums[1]!) }
}

/**
 * The option of a pay range list that holds the figure: low end at or under it, high end above it
 * ("$160,000 to $170,000" for $160,000, never "$150,000 to $160,000"). Null when no option holds it.
 */
export function rangeOptionFor(figure: number, options: string[]): string | null {
  return options.find((o) => {
    const r = optionRange(o)
    return !!r && r.low <= figure && figure < r.high
  }) ?? null
}

/** Labels that ask for a minimum, so the answer is the figure alone. */
const ASKS_MINIMUM = /\b(minimum|lowest|at least|bottom line|walk away)\b/
/** Labels that ask for total pay (base with bonus, variable, OTE). */
const ASKS_TOTAL = /\b(total|ote|on target|variable|including|bonus|commission)\b/

/**
 * The salary expectation worded for one field. A number field takes the figure; a list of pay
 * ranges takes the range that holds it; text says "$160,000" when the label asks for a minimum,
 * "$160,000 or more in total compensation" when it asks for total pay and the figure is his total
 * minimum, else "$160,000 or more base". Never a number he has not given.
 */
function salaryForField(field: FieldShape, v: FactValues): (FactValue & { exact?: boolean }) | null {
  const fact = v['work.salary']
  const figure = fact ? payFigure(fact.value) : null
  if (!fact || figure == null) return null
  const options = field.options ?? []
  if (['select', 'radio', 'checkbox_group'].includes(field.type) && options.length) {
    // Not a list of pay ranges: mapToOptions reads the options as before.
    if (options.filter(o => optionRange(o)).length < 2) return fact
    const pick = rangeOptionFor(figure, options)
    return pick ? { ...fact, value: pick, detail: `${fact.detail}, as the range that holds ${usd(figure)}`, exact: true } : null
  }
  if (field.type === 'number') return { ...fact, value: String(figure) }
  const text = labelText(field.label)
  if (ASKS_MINIMUM.test(text)) return { ...fact, value: usd(figure) }
  if (ASKS_TOTAL.test(text) && !PAY_TARGET_KB_KEYS.some(k => fact.detail === k) && fact.detail !== `question: ${TARGET_SUBJECT}`) {
    return { ...fact, value: `${usd(figure)} or more in total compensation` }
  }
  return fact
}

/** Whether the posted range works: Yes when derived, taken as it is on a Yes or No list. */
function inBandForField(_field: FieldShape, v: FactValues): (FactValue & { exact?: boolean }) | null {
  const fact = v['work.salary_in_band']
  return fact ? { ...fact, exact: true } : null
}

/** The subject of the question asked when the posted range cannot answer the field: one per application, never shared. */
export function inBandQuestionSubject(label: string, company: string, applicationId: number): string {
  const l = label.replace(/\s+/g, ' ').trim()
  return `${l.length > 150 ? `${l.slice(0, 150)}...` : l} (${company || 'the employer'}, application #${applicationId})`
}

/** True for a question asked for one application only (inBandQuestionSubject). Never reused for another form. */
export function isApplicationOnlySubject(subject: string | null | undefined): boolean {
  return /, application #\d+\)$/.test(subject ?? '')
}

function answeredAs(opts: ResolveOptions, kind: QuestionKind, subject: string): { value: string; detail: string } | null {
  const a = opts.answered?.(kind, subject)
  const value = a ? cleanStoredAnswer(a) : ''
  return value ? { value, detail: `question: ${subject}` } : null
}

/** Address parts the knowledge base does not state or imply. */
export function missingAddressParts(v: FactValues): AddressPart[] {
  const have: Record<AddressPart, boolean> = {
    street: !!v['address.street'],
    city: !!v['address.city'],
    state: !!v['address.state'],
    zip: !!v['address.zip'],
  }
  return ADDRESS_PARTS.filter(p => !have[p])
}

const PART_WORDS: Record<AddressPart, string> = { street: 'street address', city: 'city', state: 'state', zip: 'ZIP code' }

function joinWords(words: string[]) {
  if (words.length <= 1) return words.join('')
  if (words.length === 2) return `${words[0]} and ${words[1]}`
  return `${words.slice(0, -1).join(', ')}, and ${words[words.length - 1]}`
}

/** The home address is asked once. With some parts known, the question names only what is missing. */
export function addressQuestionText(missing: AddressPart[]): string {
  if (missing.length === 0 || missing.length === ADDRESS_PARTS.length) return 'What is your home address? Street, city, state, and ZIP.'
  const words = missing.map(p => PART_WORDS[p])
  return `What ${missing.length === 1 ? 'is' : 'are'} the ${joinWords(words)} of your home address?`
}

export const ADDRESS_SUBJECT = 'home address'

export const ADDRESS_QUESTION: FactQuestion = {
  kind: 'fact',
  subject: ADDRESS_SUBJECT,
  question: addressQuestionText(ADDRESS_PARTS),
  knowledgeKey: 'profile:Street Address',
  answerType: 'text',
  category: 'technical',
}

// ── The registry ─────────────────────────────────────────────

/** Labels about someone other than Devin: a reference, an emergency contact, a school, an employer. */
const SOMEONE_ELSE = /\b(emergency|reference|references|referr\w*|referred|recruiter|supervisor|manager|spouse|partner s|parent|guardian|employer|company|school|university|college|hiring|interviewer|who)\b/

/**
 * SOMEONE_ELSE without "hiring": CircleCI asks for "LinkedIn Profile (... to help us verify
 * application information and maintain the integrity of our hiring process)", which is Devin's own
 * profile. A hiring manager's profile is still excluded by "manager".
 */
const SOMEONE_ELSES_LINKEDIN = /\b(emergency|reference|references|referr\w*|referred|recruiter|supervisor|manager|spouse|partner s|parent|guardian|employer|company|school|university|college|interviewer|who)\b/

const NAME_Q: FactQuestion = { kind: 'fact', subject: 'full name', question: 'What is your full legal name?', knowledgeKey: 'profile:Full Name', answerType: 'text', category: 'technical' }

const valueOf = (key: FactKey) => (v: FactValues) => v[key] ?? null

const WORK_FACTS: Array<FactDef & { kb: string[] }> = [
  {
    key: 'work.sponsorship',
    group: 'work',
    label: 'visa sponsorship',
    matchRaw: /sponsor/i,
    value: valueOf('work.sponsorship'),
    statement: v => v['work.sponsorship'] ? `Asked whether he needs visa sponsorship now or in the future to work in the United States, Devin answered: ${v['work.sponsorship'].value}` : null,
    ask: { kind: 'fact', subject: 'visa sponsorship', question: 'Will you now or in the future need visa sponsorship to work in the United States?', knowledgeKey: 'profile:Needs Visa Sponsorship', answerType: 'yes_no', category: 'technical' },
    kb: ['profile/Needs Visa Sponsorship', 'profile/Visa Sponsorship', 'profile/Sponsorship'],
    alwaysBlocking: true,
  },
  {
    key: 'work.authorization',
    group: 'work',
    label: 'US work authorization',
    // "able to work from a state where we are registered" is about location, so plain "able" is not enough.
    matchRaw: /(authori[sz]ed|eligible|permitted|entitled) to (legally |lawfully )?work|legally (able|permitted) to work|work authori[sz]ation|right to work|employment eligibility|(legally|lawfully) work/i,
    value: valueOf('work.authorization'),
    statement: v => v['work.authorization'] ? `Asked whether he is legally authorized to work in the United States, Devin answered: ${v['work.authorization'].value}` : null,
    ask: { kind: 'fact', subject: 'US work authorization', question: 'Are you legally authorized to work in the United States?', knowledgeKey: 'profile:Work Authorization (US)', answerType: 'yes_no', category: 'technical' },
    kb: ['profile/Work Authorization (US)', 'profile/Work Authorization', 'profile/Authorized to Work in US'],
    alwaysBlocking: true,
  },
  {
    key: 'work.relocation',
    group: 'work',
    label: 'relocation',
    matchRaw: /relocat/i,
    value: valueOf('work.relocation'),
    statement: v => v['work.relocation'] ? `Asked whether he is willing to relocate, Devin answered: ${v['work.relocation'].value}` : null,
    ask: { kind: 'preference', subject: 'relocation', question: 'Are you willing to relocate for a job? If yes, where?', knowledgeKey: 'preference:Willing to Relocate', answerType: 'text', category: 'preference' },
    kb: ['preference/Willing to Relocate', 'preference/Relocation'],
    alwaysBlocking: true,
  },
  {
    key: 'work.start_date',
    group: 'work',
    label: 'start date',
    matchRaw: /start date|when (can|could|would) you (start|begin)|earliest (possible )?(date|start)|available to start|availability to start|notice period|date available/i,
    // Greenhouse's education block ("Start date month" next to School and Degree) is not this.
    contextExclude: (field, siblings) => isHistoryDate(field, siblings),
    value: valueOf('work.start_date'),
    statement: v => v['work.start_date'] ? `Asked when he could start, Devin answered: ${v['work.start_date'].value}` : null,
    ask: { kind: 'fact', subject: 'start date', question: 'When could you start a new job, or how much notice do you need to give?', knowledgeKey: 'preference:Earliest Start Date', answerType: 'text', category: 'technical' },
    kb: ['preference/Earliest Start Date', 'preference/Start Date', 'preference/Notice Period'],
    alwaysBlocking: true,
  },
  {
    // "Do you accept the listed salary range for this position?" (Samsara), "Are your salary
    // expectations for this role within the posted salary band?" (CircleCI): a yes or no about
    // this job's pay, answered per job from the posted range (resolveFacts with opts.comp). Never
    // a shared answer: when the range cannot say Yes, answers.ts asks for that application only,
    // so ask stays null and the tidy never groups these questions.
    key: 'work.salary_in_band',
    group: 'work',
    label: 'posted salary range',
    match: /\b(accept|okay|ok|comfortable|fine|agree)\b(?: \w+){0,5}? (salary|pay|compensation|base|wage) (range|band)s?\b|\bwithin\b(?: \w+){0,4}? (salary|pay|compensation|base|wage) (range|band)s?\b|\b(salary|pay|compensation|base|wage) (range|band)s?\b.*\b(acceptable|work for you|works for you|align with|in line with)\b/,
    // "Please select the salary range that best aligns with your expectations" and "What is your desired salary range?" ask for his number.
    exclude: /\b(select|choose|pick|which|what|how much|desired)\b/,
    // A list of pay ranges is the salary expectation, not a yes or no.
    contextExclude: field => (field as FieldShape).options?.length ? !(field as FieldShape).options!.some(o => /^\s*(yes|no|i (accept|agree|do|am))\b/i.test(o)) : false,
    value: valueOf('work.salary_in_band'),
    fieldValue: inBandForField,
    ask: null,
    kb: [],
    alwaysBlocking: false,
  },
  {
    key: 'work.salary',
    group: 'work',
    label: 'salary expectation',
    matchRaw: /salary|compensation (expectation|requirement)|expected (pay|compensation|salary)|desired (pay|salary|compensation)|pay expectation|compensation expectation|rate expectation|expected annual/i,
    // "Do you accept the listed salary range for this position?" is a yes or no, not his number.
    exclude: /\b(do you accept|are you (ok|okay|comfortable|fine) with|do you agree|is (this|the) (salary|range|pay) (acceptable|ok|okay))\b/,
    value: valueOf('work.salary'),
    fieldValue: salaryForField,
    statement: v => v['work.salary'] ? `Devin's salary expectation: ${v['work.salary'].value} (never state a lower figure; from ${v['work.salary'].detail})` : null,
    ask: { kind: 'preference', subject: 'salary expectation', question: 'What salary should applications list as your expectation?', knowledgeKey: 'preference:Target Salary', answerType: 'text', category: 'preference' },
    kb: ['preference/Target Salary', 'preference/Salary Expectation', 'preference/Salary Floor', 'preference/Minimum Salary'],
    alwaysBlocking: true,
  },
]

const addressFact = (key: FactKey, label: string, match: RegExp, needs: AddressPart[], extra: Partial<FactDef> = {}): FactDef => ({
  key,
  group: 'address',
  label,
  match,
  exclude: SOMEONE_ELSE,
  value: valueOf(key),
  needs,
  ask: ADDRESS_QUESTION,
  storeKey: ADDRESS_STORE_KEYS[key] ?? ADDRESS_KNOWLEDGE_KEYS.location,
  alwaysBlocking: false,
  ...extra,
})

const ADDRESS_STORE_KEYS: Partial<Record<FactKey, string>> = {
  'address.street': 'profile:Street Address',
  'address.city': 'profile:City',
  'address.state': 'profile:State',
  'address.zip': 'profile:Zip Code',
  'address.country': 'profile:Country',
  'address.full': 'profile:Home Address',
}

const locationStatement = (v: FactValues) => {
  const loc = v['address.location']
  if (!loc) return null
  const country = v['address.country']?.value
  return `Devin currently lives in ${loc.value}${country ? `, ${country}` : ''}.`
}

/**
 * Every fact, in match order: the first definition whose pattern matches a label wins. Specific
 * patterns come before general ones ("City, State, Country" before "City", initials before name).
 */
export const PERSONAL_FACTS: FactDef[] = [
  ...WORK_FACTS,
  {
    key: 'contact.linkedin',
    group: 'contact',
    label: 'LinkedIn URL',
    match: /linked ?in/,
    exclude: SOMEONE_ELSES_LINKEDIN,
    value: valueOf('contact.linkedin'),
    statement: v => v['contact.linkedin'] ? `Devin's LinkedIn profile: ${v['contact.linkedin'].value}` : null,
    ask: { kind: 'fact', subject: 'LinkedIn URL', question: 'What is your LinkedIn profile URL? Answer "none" if you do not use LinkedIn.', knowledgeKey: 'profile:LinkedIn', answerType: 'text', category: 'technical' },
    alwaysBlocking: false,
  },
  {
    key: 'contact.github_username',
    group: 'contact',
    label: 'GitHub username',
    match: /git ?hub (username|user name|handle|login|id)/,
    exclude: SOMEONE_ELSE,
    value: valueOf('contact.github_username'),
    ask: { kind: 'fact', subject: 'GitHub username', question: 'What is your GitHub username? Answer "none" if you do not use GitHub.', knowledgeKey: 'profile:GitHub', answerType: 'text', category: 'technical' },
    alwaysBlocking: false,
  },
  {
    key: 'contact.github',
    group: 'contact',
    label: 'GitHub URL',
    match: /git ?hub/,
    exclude: SOMEONE_ELSE,
    value: valueOf('contact.github'),
    ask: { kind: 'fact', subject: 'GitHub username', question: 'What is your GitHub username? Answer "none" if you do not use GitHub.', knowledgeKey: 'profile:GitHub', answerType: 'text', category: 'technical' },
    alwaysBlocking: false,
  },
  {
    key: 'contact.email',
    group: 'contact',
    label: 'email address',
    match: /^((your|personal|preferred|primary|contact) )?email( address)?$|^confirm (your )?email( address)?$/,
    types: ['email'],
    exclude: SOMEONE_ELSE,
    value: valueOf('contact.email'),
    ask: { kind: 'fact', subject: 'email address', question: 'What email address should applications use?', knowledgeKey: 'profile:Email', answerType: 'text', category: 'technical' },
    alwaysBlocking: false,
  },
  {
    key: 'contact.phone',
    group: 'contact',
    label: 'phone number',
    match: /^((your|personal|preferred|primary|contact|mobile|cell|home) )?(phone|mobile|cell|telephone)( number| phone)?$|phone number|mobile number|cell number|contact number/,
    types: ['tel'],
    exclude: SOMEONE_ELSE,
    value: valueOf('contact.phone'),
    ask: { kind: 'fact', subject: 'phone number', question: 'What phone number should applications use?', knowledgeKey: 'profile:Phone', answerType: 'text', category: 'technical' },
    alwaysBlocking: false,
  },
  {
    key: 'name.middle_initial',
    storeKey: 'profile:Middle Name',
    group: 'name',
    label: 'middle initial',
    match: /middle (initial|name)/,
    exclude: SOMEONE_ELSE,
    value: valueOf('name.middle_initial'),
    // Two names and no middle one: nothing to fill, and nothing worth asking.
    ask: null,
    alwaysBlocking: false,
  },
  {
    key: 'name.initials',
    storeKey: 'profile:Initials',
    group: 'name',
    label: 'initials',
    // "initial interview" and "initial salary" are not initials.
    match: /\binitials\b|^((applicant|candidate|your) )?initial$|^please initial\b|\binitial here\b|sign with your initial/,
    exclude: SOMEONE_ELSE,
    value: valueOf('name.initials'),
    ask: NAME_Q,
    alwaysBlocking: false,
  },
  {
    key: 'name.first',
    storeKey: 'profile:First Name',
    group: 'name',
    label: 'first name',
    match: /^((legal|your|applicant|candidate) )?first name$|^given name$|^first$|^first name legal$/,
    exclude: SOMEONE_ELSE,
    value: valueOf('name.first'),
    ask: NAME_Q,
    alwaysBlocking: false,
  },
  {
    key: 'name.last',
    storeKey: 'profile:Last Name',
    group: 'name',
    label: 'last name',
    match: /^((legal|your|applicant|candidate) )?last name( surname)?$|^surname$|^family name$|^last$|^last name legal$/,
    exclude: SOMEONE_ELSE,
    value: valueOf('name.last'),
    ask: NAME_Q,
    alwaysBlocking: false,
  },
  {
    key: 'name.preferred',
    storeKey: 'profile:Preferred Name',
    group: 'name',
    label: 'preferred name',
    match: /preferred (first )?name|name you d prefer|prefer us to use|nickname|what should we call you|name you go by/,
    exclude: SOMEONE_ELSE,
    value: valueOf('name.preferred'),
    ask: NAME_Q,
    alwaysBlocking: false,
    confidence: 'medium',
  },
  {
    key: 'name.signature',
    storeKey: 'profile:Full Name',
    group: 'name',
    label: 'typed signature',
    match: /^((electronic|digital|applicant|candidate|your) )?signature$|type your (full |legal )?name/,
    exclude: /date|draw/,
    value: valueOf('name.signature'),
    ask: NAME_Q,
    alwaysBlocking: false,
  },
  {
    key: 'name.full',
    storeKey: 'profile:Full Name',
    group: 'name',
    label: 'full name',
    match: /^((full|legal|your|candidate|applicant|full legal|your full|your legal) )?name$|^(first and last|full) name( first and last)?$|^name first and last$/,
    exclude: SOMEONE_ELSE,
    value: valueOf('name.full'),
    ask: NAME_Q,
    alwaysBlocking: false,
  },
  addressFact('address.line2', 'address line 2', /address line 2|^address 2$|^address2$|^(apt|apartment|suite|unit)( suite| unit| number| no| apt)*$|^apt suite/, [], {
    // Line 2 is never asked: an address without one is the usual case.
    ask: null,
  }),
  addressFact('address.city_state_zip', 'city, state and ZIP', /city state (and )?zip/, ['city', 'state', 'zip']),
  addressFact('address.city_state_country', 'city, state and country', /city state (and )?country|city state province (and )?country/, ['city', 'state']),
  addressFact('address.city_country', 'city and country', /^city (and )?country$|^city country$|\bcity and country\b|\bcity country\b/, ['city', 'state']),
  addressFact('address.zip', 'ZIP code', /\b(zip|zipcode|postal code|postcode|post code)\b/, ['zip']),
  addressFact('address.street', 'street address', /street|address line 1|^address 1$|^address1$/, ['street']),
  addressFact('address.full', 'home address',
    /^((home|mailing|current|residential|permanent|physical|full|your|postal|primary) )*address$|what is your ((home|mailing|current|residential) )*address|address where you (live|reside)|^(full|complete) (home |mailing )?address/, ['street', 'city', 'state', 'zip'],
    { exclude: /email|e mail|ip address|web address|url|company|employer|school|reference|emergency/ }),
  addressFact('address.us_resident', 'lives in the United States',
    // "in" must come right before the country: "where you live, let us know" is not about the US.
    /\b(reside|live|living|located|based)\b( \w+){0,3} in (the )?(u s|us|usa|united states)\b/, ['state'],
    { exclude: /outside|not\b|other than|willing|relocat|canada|mexico|europe|uk\b/, choiceValues: v => (v['address.us_resident'] ? ['Yes'] : []), statement: locationStatement }),
  addressFact('address.country', 'country',
    /^(current )?country( of residence)?$|country of residence|country you (currently )?(live|reside) in|(what|which) country (do|are) you (currently )?(live|reside|based|located)|^country region$/, ['state'],
    { choiceValues: v => (v['address.country'] ? [v['address.country'].value, 'United States of America', 'USA', 'US'] : []) }),
  addressFact('address.state', 'state',
    /^((current|home) )?state( province)?( region)?$|^state of residence$|^province$|^state region$|(what|which) state (do|are) you (currently )?(live|reside|based|located)/, ['state'],
    { choiceValues: v => (v['address.state'] ? [US_STATES[v['address.state'].value] ?? v['address.state'].value, v['address.state'].value] : []) }),
  addressFact('address.city', 'city', /^((current|home) )?city( town)?$|^town city$|^city of residence$/, ['city']),
  addressFact('address.location', 'city and state',
    /city and state|^city state$|^(current )?location\b|^location city state$|where are you (currently )?(located|based)$|where do you (currently )?(live|reside)$|(what|which) city (and state )?(do|are) you (currently )?(live|reside|based|located)|city (and state )?(do|are) you (currently )?(and permanently )?(live|reside)|currently (and permanently )?(live|reside) in$|^what is your (current )?location$|^location where you (live|reside)/, ['city', 'state'],
    { choiceValues: v => [v['address.location']?.value, v['address.city_state_country']?.value, v['address.country']?.value].filter((x): x is string => !!x), statement: locationStatement }),
  addressFact('address.timezone', 'time zone', /time ?zone/, ['city', 'state'], { value: () => null, statement: locationStatement }),
  addressFact('address.location_judgment', 'where you live',
    // The location statement goes to mapToOptions for these: "Are you based in the US or Canada?",
    // "Do you live within commuting distance of Austin?", "State where you will work".
    /where are you (currently )?(located|based)|are you (currently )?(based|located|living|residing) in|do you (currently )?(reside|live)|state where you (will )?(reside|live|work)|(country|city|state) (are|do) you (currently )?(based|located|live|reside)|where do you live/, ['city', 'state'],
    // "Are you located in and willing to work in the location where the job is posted?" (CircleCI)
    // asks a yes or no about the job's location, not where he lives: it gets its own form question.
    { value: () => null, statement: locationStatement, exclude: new RegExp(`${SOMEONE_ELSE.source}|\\bwilling\\b|\\bwhere the job is\\b`) }),
  {
    key: 'contact.website',
    storeKey: 'profile:Website',
    group: 'contact',
    label: 'website or portfolio',
    match: /portfolio|personal (website|site|url|page)|^((your|personal) )?(web ?site|homepage|blog)( url| link)?$/,
    exclude: /other website|company|employer|twitter|linkedin/,
    value: valueOf('contact.website'),
    ask: { kind: 'fact', subject: 'website', question: 'What is your portfolio or personal website URL? Answer "none" if you do not have one.', knowledgeKey: 'profile:Website', answerType: 'text', category: 'technical' },
    alwaysBlocking: false,
  },
]

export interface FieldLike {
  label: string
  type: string
  isEeo?: boolean
  section?: string | null
}

/** Wording that can only mean when Devin could start a new job. */
const AVAILABILITY_WORDING = /\bwhen (can|could|would) you\b|\bearliest\b|\bavailab|\bnotice\b|\b(desired|anticipated|expected|preferred|possible) start\b|\bable to (start|begin|join)\b/
/** A date split into parts: "Start date month", "Start date year". */
const DATE_PART = /\b(month|year|day|mm|yyyy|yy)\b/
/** The fields of a school or a job in an education or work history group. */
const HISTORY_FIELD = /\b(school|university|college|institution|degree|discipline|major|minor|field of study|gpa|graduat\w*|employer|(job|position) title|currently (work|attend|study)\w*( here)?)\b|^(company|company name|title)$/
const HISTORY_SECTION = /\b(education|employment|work history|work experience|experience|previous (jobs?|employers?|positions?))\b/
/** How far a neighbor may sit from the date and still be in its group. */
const HISTORY_REACH = 4

/**
 * A start date that belongs to a school or a job in the applicant's history, not to when Devin
 * could start a new job. Greenhouse's education block reads School, Degree, Discipline, Start date
 * month, Start date year, End date month, End date year. A label worded as availability ("earliest
 * start date", "when could you start") is never history.
 */
export function isHistoryDate(field: FieldLike, siblings: FieldLike[] = []): boolean {
  const text = labelText(field.label)
  if (!/\bstart(ed|ing)? date\b|\bdate started\b/.test(text) || AVAILABILITY_WORDING.test(text)) return false
  if (DATE_PART.test(text)) return true
  if (field.section && HISTORY_SECTION.test(labelText(field.section))) return true
  let at = siblings.indexOf(field)
  if (at < 0) at = siblings.findIndex(s => s.label === field.label)
  if (at < 0) return false
  const near = siblings.slice(Math.max(0, at - HISTORY_REACH), at + HISTORY_REACH + 1).filter(s => s !== siblings[at])
  return near.some((s) => {
    const t = labelText(s.label)
    return HISTORY_FIELD.test(t) || /^(end|ended|ending) date\b|\bdate (ended|left)\b/.test(t)
  })
}

/**
 * The fact a form field asks for, or null when it is not a personal fact. `siblings` are every
 * field of the form in order (the field among them), so a label can be read in its group.
 */
export function matchFact(field: FieldLike, siblings: FieldLike[] = []): FactDef | null {
  if (field.isEeo || field.type === 'file') return null
  const text = labelText(field.label)
  for (const def of PERSONAL_FACTS) {
    if (def.exclude?.test(text)) continue
    if (def.matchRaw?.test(field.label) || def.match?.test(text)) {
      if (def.contextExclude?.(field, siblings)) continue
      return def
    }
  }
  // An email or phone input is the email address or phone number whatever its label says.
  for (const def of PERSONAL_FACTS) {
    if (def.types?.includes(field.type) && !def.exclude?.test(text)) return def
  }
  return null
}

/** The fact a question asks about, from its subject and wording. Used to merge existing duplicates. */
export function factForQuestion(q: { kind: string | null; subject: string | null; question: string }): FactDef | null {
  if (q.kind !== 'fact' && q.kind !== 'form_field' && q.kind !== 'preference') return null
  const subject = (q.subject ?? '').trim().toLowerCase()
  if (subject === ADDRESS_SUBJECT || subject === 'current location' || subject === 'zip code') return PERSONAL_FACTS.find(d => d.key === (subject === 'zip code' ? 'address.zip' : 'address.location'))!
  if (subject === 'full name') return PERSONAL_FACTS.find(d => d.key === 'name.full')!
  const bySubject = PERSONAL_FACTS.find(d => d.ask && d.ask.subject.toLowerCase() === subject && d.ask.kind === q.kind)
  if (bySubject) return bySubject
  if (q.kind === 'preference') return null
  return matchFact({ label: q.subject || q.question, type: 'text' }) ?? matchFact({ label: q.question, type: 'text' })
}

/** The question to ask for a fact, worded for what is still missing (the address asks only for its missing parts). */
export function questionFor(def: FactDef, v: FactValues): FactQuestion | null {
  if (!def.ask) return null
  if (def.ask.subject !== ADDRESS_SUBJECT) return def.ask
  return { ...def.ask, question: addressQuestionText(missingAddressParts(v)) }
}

/** True when the single address question is the one to ask for this fact. */
export function isAddressQuestion(q: { kind: string | null; subject: string | null }): boolean {
  return q.kind === 'fact' && (q.subject ?? '').trim().toLowerCase() === ADDRESS_SUBJECT
}

/** Short sentences of every resolved fact, for prompts that answer the rest of a form. */
export function factStatements(v: FactValues): string[] {
  const out: string[] = []
  for (const def of WORK_FACTS) {
    const s = def.statement?.(v)
    if (s) out.push(s)
  }
  if (v['name.full']) out.push(`Devin's full name: ${v['name.full'].value}${v['name.initials'] ? ` (initials ${v['name.initials'].value})` : ''}`)
  if (v['address.full']) out.push(`Devin's home address: ${v['address.full'].value}`)
  else if (v['address.location']) out.push(`Devin currently lives in: ${v['address.location'].value}`)
  if (v['address.zip'] && !v['address.full']) out.push(`Devin's home zip code: ${v['address.zip'].value}`)
  if (v['contact.linkedin']) out.push(`Devin's LinkedIn profile: ${v['contact.linkedin'].value}`)
  return out
}

/**
 * Splits Devin's answer to the address question into its parts. Parts he already stated stay as
 * they are unless the answer restates them. Returns null when the answer does not give every part
 * the question asked for, so the caller can ask him to write it out.
 */
export function addressAnswerParts(answer: string, missing: AddressPart[]): { parts: AddressParts; missingAfter: AddressPart[] } {
  const p = parseAddress(answer)
  // "Columbus, OH" for a question that asked only for the city and state.
  if (!p.city && !p.street && missing.every(m => m === 'city' || m === 'state')) {
    const loose = answer.trim().match(/^([^,\d]+?)[,\s]+([a-z .]+)$/i)
    if (loose && stateCode(loose[2]!)) {
      p.city = loose[1]!.trim()
      p.state = stateCode(loose[2]!)!
    }
  }
  if (!p.zip && missing.length === 1 && missing[0] === 'zip') {
    const zip = answer.match(/\b\d{5}(-\d{4})?\b/)
    if (zip) p.zip = zip[0]
  }
  if (!p.street && missing.length === 1 && missing[0] === 'street' && /^\d/.test(answer.trim())) p.street = answer.trim().replace(/[.,\s]+$/, '')
  const got: Record<AddressPart, boolean> = { street: !!p.street, city: !!p.city, state: !!p.state, zip: !!p.zip }
  return { parts: p, missingAfter: missing.filter(m => !got[m]) }
}

/** Where Devin's own answer to this fact is stored, "category:key". */
export function storeKeyOf(def: FactDef): string | null {
  return def.storeKey ?? def.ask?.knowledgeKey ?? null
}

export function factByKey(key: FactKey): FactDef {
  return PERSONAL_FACTS.find(d => d.key === key)!
}

/** True when the fact belongs to the home address, which is asked and stored as one thing. */
export function isAddressFact(def: FactDef | null | undefined): boolean {
  return def?.group === 'address'
}

// ── Answering one field from the facts ───────────────────────

export interface FieldShape extends FieldLike {
  options?: string[]
}

export type FieldResolution =
  /** The value answers the field. For a choice field, `choices` are tried against its options in order. */
  | { kind: 'value'; value: string; detail: string; confidence: 'high' | 'medium'; choices: string[]; statement: string }
  /** The field needs judgment on top of the fact (a time zone, a negated yes/no); mapToOptions decides from the statement. */
  | { kind: 'map'; statement: string; detail: string }
  /** Nothing to fill and nothing worth asking (no apartment number, no middle name). */
  | { kind: 'blank'; detail: string }
  /** The fact is unknown: ask this question. */
  | { kind: 'ask'; question: FactQuestion }

const SEPARATE_PART_FACTS: FactKey[] = ['address.city', 'address.state', 'address.zip', 'address.location', 'address.city_state_zip', 'address.city_state_country', 'address.city_country']

/**
 * How one field is answered from the resolved facts. `siblings` are the other fields of the same
 * form: an "Address" field on a form that also asks for the city or the ZIP wants only the street.
 */
export function resolveField(def: FactDef, field: FieldShape, v: FactValues, siblings: FieldLike[] = []): { def: FactDef; res: FieldResolution } {
  let d = def
  if (d.key === 'address.full' && !/full|complete/.test(labelText(field.label))) {
    const separate = siblings.some(s => s !== field && SEPARATE_PART_FACTS.includes(matchFact(s)?.key as FactKey))
    if (separate) d = factByKey('address.street')
  }
  const val = d.fieldValue ? d.fieldValue(field, v) : d.value(v)
  const statement = d.statement?.(v) ?? (val ? `${field.label}: ${val.value}` : null)
  if (val) {
    // The work facts are yes/no answers that a negated label flips ("without sponsorship"), so
    // their choice fields always go through mapToOptions, which handles the negation. A value
    // already picked from the options in code (a pay range, the posted range's Yes) is used as it is.
    const choiceField = ['select', 'radio', 'checkbox', 'checkbox_group'].includes(field.type) && (field.options?.length ?? 0) > 0
    if (d.group === 'work' && choiceField && !('exact' in val && val.exact)) return { def: d, res: { kind: 'map', statement: statement!, detail: val.detail } }
    const choices = d.choiceValues?.(v) ?? [val.value]
    return { def: d, res: { kind: 'value', value: val.value, detail: val.detail, confidence: d.confidence ?? 'high', choices: choices.length ? choices : [val.value], statement: statement! } }
  }
  if (statement && d.statement) return { def: d, res: { kind: 'map', statement, detail: d.label } }
  const q = questionFor(d, v)
  if (q) return { def: d, res: { kind: 'ask', question: q } }
  return { def: d, res: { kind: 'blank', detail: d.key === 'address.line2' ? 'Left blank: the stored address has no apartment or suite' : d.key === 'name.middle_initial' ? 'Left blank: the knowledge base has no middle name' : `Left blank: nothing stored for ${d.label}` } }
}

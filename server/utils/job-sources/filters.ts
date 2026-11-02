// Shared listing filters, so every source applies the search config the same way.

const SYNONYMS: Record<string, string[]> = {
  developer: ['developer', 'engineer', 'programmer'],
  engineer: ['engineer', 'developer'],
  senior: ['senior', 'sr'],
  tech: ['tech', 'technical'],
  technical: ['tech', 'technical'],
  lead: ['lead'],
}
/** Words a keyword may contain that a title does not need ("senior software engineer" matches "Senior Engineer"). */
const OPTIONAL_WORDS = new Set(['software', 'a', 'an', 'the', 'of'])

function tokens(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9#+.]+/g, ' ').split(' ').map(t => t.replace(/\.+$/, '')).filter(Boolean)
}

function hasToken(titleTokens: Set<string>, word: string) {
  const options = SYNONYMS[word] ?? [word]
  return options.some(o => titleTokens.has(o) || titleTokens.has(`${o}s`))
}

/**
 * True when the title contains every meaningful word of at least one keyword, in any order,
 * allowing common synonyms (developer and engineer, senior and sr).
 * "senior developer" matches "Senior Backend Engineer"; "tech lead" matches "Technical Lead, Payments".
 */
export function titleMatchesKeywords(title: string, keywords: string[]): boolean {
  if (!keywords.length) return true
  const set = new Set(tokens(title))
  return keywords.some((k) => {
    const words = tokens(k).filter(w => !OPTIONAL_WORDS.has(w))
    return words.length > 0 && words.every(w => hasToken(set, w))
  })
}

/** Which keywords the title matches, for prefilter scoring and run stats. */
export function matchedKeywords(title: string, keywords: string[]): string[] {
  return keywords.filter(k => titleMatchesKeywords(title, [k]))
}

const ENGINEERING_TITLE = /\b(engineers?|engineering|developers?|programmers?|architects?|sre|devops|full[\s-]?stack|back[\s-]?end|front[\s-]?end|software|cto|tech(nical)? lead)\b/i

export function isEngineeringTitle(title: string): boolean {
  return ENGINEERING_TITLE.test(title)
}

// Titles that contain "engineer" or "engineering" but are sales, support, services, or hardware roles.
const NON_SOFTWARE_TITLE = /\b(sales|pre[\s-]?sales|customer success|professional services|solutions? (engineer\w*|architect\w*|consult\w*)|support engineer\w*|field (engineer\w*|service\w*)|deployment strategist|forward deployed|recruit(er|ing)?|account (executive|manager)|hardware|mechanical|electrical|manufacturing|analog|rf|silicon|asic|fpga|chip|technical writer|partner engineer\w*|implementation)\b/i

/** An engineering title that is not a sales, support, services, or hardware role. */
// Healthcare and trades titles that match "tech lead" or "engineer" ("Sterile Processing Tech
// Lead", "HVAC Controls Engineer"). They only rule a title out when it names no software work,
// so "Staff Engineer, Patient Platform" and "Software Engineer, Medical Devices" stay in.
const NON_TECH_DOMAIN = /\b(sterile|surgical|nurs(e|es|ing)|clinical|medical|pharmac\w*|dental|veterinar\w*|patient|laborator\w*|radiolog\w*|hvac|plumb\w*|maintenance|facilities|warehouse|construction|processing tech\w*)\b/i
const SOFTWARE_WORD = /\b(software|developers?|programmers?|full[\s-]?stack|front[\s-]?end|back[\s-]?end|devops|sre|platform|web|mobile|ios|android|cloud|data|api|systems? software|applications?)\b/i

export function isSoftwareRoleTitle(title: string): boolean {
  if (!isEngineeringTitle(title) || NON_SOFTWARE_TITLE.test(title)) return false
  return !(NON_TECH_DOMAIN.test(title) && !SOFTWARE_WORD.test(title))
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Regex for a term with boundaries that work for "C#", ".NET", and "Java" (which must not match "JavaScript"). */
export function termRegex(term: string): RegExp {
  return new RegExp(`(?<![a-z0-9])${escapeRegex(term.toLowerCase().trim())}(?![a-z0-9])`, 'i')
}

export function matchesAnyTerm(text: string, terms: string[] | undefined): string | null {
  if (!terms?.length || !text) return null
  for (const t of terms) {
    if (t.trim() && termRegex(t).test(text)) return t
  }
  return null
}

const US_STATES = ['Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming', 'District of Columbia']
const US_ABBR = 'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC'
// The bare abbreviations only count in capitals: lowercase "us" is a pronoun.
const US_ABBREVIATION = /\b(US|USA|U\.S\.A?\.?)(?![a-z])/
const US_NAMES = /\b(united states|north america|americas|namer|amer)\b/i
const NON_US_AMERICA = /\b(latin|south|central)\s+america\b/i
const US_STATE_ABBR_AFTER_COMMA = new RegExp(`(,|\\s-|\\()\\s*(${US_ABBR})\\b`)
const US_STATE_NAME = new RegExp(`\\b(${US_STATES.join('|')})\\b`, 'i')
const US_CITY = /\b(san francisco|new york city|nyc|seattle|austin|boston|chicago|denver|los angeles|atlanta|bay area|santa clara|silicon valley)\b/i
// Adzuna writes US locations as "Buffalo, Erie County" with no state.
const US_COUNTY = /\b[A-Z][a-z]+(\s[A-Z][a-z]+)?\sCounty\b/

function segmentIsUs(seg: string): boolean {
  if (US_ABBREVIATION.test(seg)) return true
  if (US_NAMES.test(seg)) return true
  if (/\bamerica\b/i.test(seg) && !NON_US_AMERICA.test(seg)) return true
  return US_STATE_ABBR_AFTER_COMMA.test(seg) || US_STATE_NAME.test(seg) || US_CITY.test(seg) || US_COUNTY.test(seg)
}

/** Sources whose query only returns US listings (Adzuna's /us/ endpoint, Jobicy with geo=usa). */
export const US_ONLY_SOURCES = new Set(['adzuna', 'jobicy'])

const WORLDWIDE_WORDS = new Set(['remote', 'fully', 'anywhere', 'worldwide', 'global', 'globally', 'distributed', 'work', 'from', 'home', 'wfh', 'in', 'the', 'world', 'earth', 'any', 'location', 'locations', 'flexible'])

export type UsEligibility = 'us' | 'worldwide' | 'non_us' | 'unknown'

/**
 * Whether a listing's locations let a US-based person apply.
 * - us: a location names the US, a state, a US city, or North America.
 * - worldwide: a location is only "Remote", "Anywhere", "Global" and similar.
 * - non_us: locations exist and none of them include the US.
 */
export function usEligibility(locations: Array<string | null | undefined>): UsEligibility {
  const segments = locations
    .filter((l): l is string => !!l && !!l.trim())
    .flatMap(l => l.split(/;|\||\/|\bor\b/i))
    .map(s => s.trim())
    .filter(Boolean)
  if (!segments.length) return 'unknown'
  let worldwide = false
  for (const seg of segments) {
    if (segmentIsUs(seg)) return 'us'
    const words = seg.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean)
    if (words.length && words.every(w => WORLDWIDE_WORDS.has(w))) worldwide = true
  }
  return worldwide ? 'worldwide' : 'non_us'
}

export function isUsEligible(locations: Array<string | null | undefined>): boolean {
  const e = usEligibility(locations)
  return e === 'us' || e === 'worldwide'
}

const REMOTE_PATTERN = /\b(remote|anywhere|distributed|work from home|wfh)\b/i

export function looksRemote(...texts: Array<string | null | undefined>): boolean {
  return texts.some(t => !!t && REMOTE_PATTERN.test(t))
}

/** True when the listing's stated pay is entirely below the floor. Unknown pay never fails. */
export function payBelow(floor: number | undefined, min: number | null | undefined, max: number | null | undefined): boolean {
  if (!floor) return false
  const top = max ?? min
  return top != null && top > 0 && top < floor
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/g, '\'')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&amp;/g, '&')
}

/** Removes scripts, styles, frames, inline handlers, and javascript: links from third-party HTML. */
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<(script|style|iframe|object|embed|noscript)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(script|style|iframe|object|embed|link|meta)[^>]*\/?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1="#"')
}

/** Lowercase company name with punctuation and legal suffixes removed, for matching across sources. */
export function normalizeCompany(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company|gmbh|pbc|plc|technologies|technology|labs|hq)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, '')
}

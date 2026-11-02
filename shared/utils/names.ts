// Product names for the ids the pipeline stores: job sources (server/utils/job-sources) and
// application form systems (AtsType). Shared so server-built text ("Adzuna search failed") and
// the screens say the same name.

const PROPER: Record<string, string> = {
  // Job sources
  adzuna: 'Adzuna',
  arbeitnow: 'Arbeitnow',
  himalayas: 'Himalayas',
  jobicy: 'Jobicy',
  jsearch: 'JSearch',
  remoteok: 'RemoteOK',
  remotive: 'Remotive',
  manual: 'Added by hand',
  // Form systems, several of which are also job sources
  ashby: 'Ashby',
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  workable: 'Workable',
  smartrecruiters: 'SmartRecruiters',
  recruitee: 'Recruitee',
  bamboohr: 'BambooHR',
  jobvite: 'Jobvite',
  workday: 'Workday',
  icims: 'iCIMS',
  taleo: 'Taleo',
  successfactors: 'SuccessFactors',
  sandbox: 'Sandbox',
}

/** A job source or ATS id as its product name: "ashby" becomes "Ashby", "jsearch" becomes "JSearch". */
export function properName(id: string | null | undefined): string {
  if (!id) return ''
  return PROPER[id.toLowerCase()] ?? id.charAt(0).toUpperCase() + id.slice(1)
}

// Lowercase ids only, as whole words: text that already says "Adzuna" is left alone, and plain
// words that happen to be ids ("sandbox", "manual", "lever") are not touched outside a source list.
const SOURCE_IDS = ['adzuna', 'arbeitnow', 'himalayas', 'jobicy', 'jsearch', 'remoteok', 'remotive', 'greenhouse', 'ashby', 'lever', 'workable', 'smartrecruiters', 'recruitee']
const SOURCE_LIST = new RegExp(`\\b((?:${SOURCE_IDS.join('|')})(?:, (?:${SOURCE_IDS.join('|')}))*) search failed\\b`, 'g')
const SOURCE_WORD = new RegExp(`\\b(${SOURCE_IDS.filter(id => !['lever', 'workable'].includes(id)).join('|')})\\b`, 'g')

/**
 * Job source ids inside stored text as product names, at display time: "adzuna search failed"
 * becomes "Adzuna search failed". Problems recorded on old runs kept the lowercase id.
 */
export function properNamesIn(text: string): string {
  return text
    .replace(SOURCE_LIST, (_m, list: string) => `${list.split(', ').map(properName).join(', ')} search failed`)
    .replace(SOURCE_WORD, id => properName(id))
}

// Well-known technology names as their makers write them. Requirement lines copy whatever the
// posting typed ("React + Typescript"), and the reject dialog's chips are built from them.
const SKILL_NAMES: Record<string, string> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  github: 'GitHub',
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
  graphql: 'GraphQL',
  nodejs: 'Node.js',
  nextjs: 'Next.js',
  vuejs: 'Vue.js',
  oauth: 'OAuth',
  ios: 'iOS',
}

/** Lowercase, without spaces, dots, or hyphens: "Node JS", "node.js", and "NodeJS" share a key. */
function skillKey(name: string): string {
  return name.toLowerCase().replace(/[\s.-]+/g, '')
}

/**
 * A skill name with well-known technologies spelled their own way: "Typescript" becomes
 * "TypeScript", "nodejs" becomes "Node.js", and "Typescript and Github" becomes "TypeScript and
 * GitHub". The whole name is tried first, then each word. Names the map does not know come back unchanged.
 */
export function properSkillName(name: string): string {
  const whole = SKILL_NAMES[skillKey(name)]
  if (whole) return whole
  return name.replace(/[A-Za-z][A-Za-z.]*[A-Za-z]/g, word => SKILL_NAMES[skillKey(word)] ?? word)
}

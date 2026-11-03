import { eq } from 'drizzle-orm'
import { jobs } from '../../db/schema'
import { normalizeCompany } from './filters'

// Cross-source duplicates. The same posting often arrives from two places (a Greenhouse board and
// Himalayas, Adzuna and an Ashby board). Identity stays source + source id, so the second copy is
// still stored, but it is marked as a duplicate of the first (jobs.duplicate_of) before anything
// queues it for reading, so it is never read or scored. Same company and title after
// normalizing, and locations that can be the same place (both remote, one names no place, or they
// share a place word). Only copies from different sources count: one source listing the same title
// twice is two postings (Samsara's six city postings).

/** Location and remote words that say nothing about which place a listing is in. */
const GENERIC_PLACE = new Set(['remote', 'united', 'states', 'usa', 'the', 'and', 'anywhere', 'world', 'worldwide', 'global', 'hybrid', 'onsite', 'office', 'north', 'america', 'americas', 'county', 'many', 'countries', 'including', 'only', 'from', 'home', 'work', 'flexible', 'location', 'locations', 'multiple', 'any'])
const PLACE_WORDS = /\b(remote|hybrid|on-?site|anywhere|worldwide|global|us|usa|u\.s\.?|united states|canada|americas|north america|emea|latam|apac|europe|uk)\b/i

/** Title for comparison: lowercase, "Sr." as senior, location and remote tags removed. */
export function normalizeTitle(title: string): string {
  let t = title.toLowerCase()
  // "(Remote)", "[US]", "(Remote - US)": bracketed tags that name a place or remote.
  t = t.replace(/[([][^)\]]*[)\]]/g, m => (PLACE_WORDS.test(m) ? ' ' : m))
  // Trailing " - Remote", " | United States", " – US": separated tags made only of place words.
  for (;;) {
    const m = t.match(/\s[-|–—/:]\s*([^-|–—/:]+)$/)
    if (!m || !PLACE_WORDS.test(m[1]!) || m[1]!.replace(PLACE_WORDS, '').replace(/[^a-z]+/g, '').length > 3) break
    t = t.slice(0, m.index)
  }
  return t
    .replace(/&/g, ' and ')
    .replace(/\bsr\b\.?/g, 'senior')
    .replace(/\bjr\b\.?/g, 'junior')
    .replace(/[^a-z0-9+#]+/g, ' ')
    .trim()
}

function placeWords(location: string | null | undefined): Set<string> {
  return new Set((location ?? '').toLowerCase().split(/[^a-z]+/).filter(w => w.length >= 3 && !GENERIC_PLACE.has(w)))
}

export function locationsCompatible(a: { location: string | null | undefined; remote: boolean }, b: { location: string | null | undefined; remote: boolean }): boolean {
  if (a.remote && b.remote) return true
  const pa = placeWords(a.location)
  const pb = placeWords(b.location)
  if (!pa.size || !pb.size) return true
  for (const w of pa) if (pb.has(w)) return true
  return false
}

interface Entry {
  id: number
  canonicalId: number
  source: string
  location: string | null
  remote: boolean
}

export interface DuplicateMatch {
  jobId: number
  source: string
}

/** Stored jobs by company and title, to find the job a new listing repeats. */
export class DuplicateIndex {
  private byKey = new Map<string, Entry[]>()

  static load(): DuplicateIndex {
    const index = new DuplicateIndex()
    const rows = useDb().select({ id: jobs.id, source: jobs.source, company: jobs.company, title: jobs.title, location: jobs.location, remoteType: jobs.remoteType, duplicateOf: jobs.duplicateOf })
      .from(jobs)
      .where(eq(jobs.isSandbox, false))
      .all()
    for (const r of rows) index.add(r.id, r.duplicateOf ?? r.id, r)
    return index
  }

  private key(company: string, title: string) {
    return `${normalizeCompany(company)}\u001F${normalizeTitle(title)}`
  }

  add(id: number, canonicalId: number, job: { source: string; company: string; title: string; location?: string | null; remoteType?: string | null }) {
    const key = this.key(job.company, job.title)
    const list = this.byKey.get(key) ?? []
    list.push({ id, canonicalId, source: job.source, location: job.location ?? null, remote: job.remoteType === 'remote' })
    this.byKey.set(key, list)
  }

  /** The job a listing from `source` repeats, when another source already brought it. */
  find(job: { source: string; company: string; title: string; location?: string | null; remoteType?: string | null }): DuplicateMatch | null {
    if (!normalizeCompany(job.company) || job.company === 'Unknown') return null
    const list = this.byKey.get(this.key(job.company, job.title))
    if (!list) return null
    const me = { location: job.location ?? null, remote: job.remoteType === 'remote' }
    const hit = list.find(e => e.source !== job.source && locationsCompatible(me, e))
    if (!hit) return null
    const canonical = list.find(e => e.id === hit.canonicalId)
    return { jobId: hit.canonicalId, source: canonical?.source ?? hit.source }
  }
}

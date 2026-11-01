import type { AtsType } from '#shared/types/pipeline'

export interface NormalizedJob {
  source: string
  sourceId: string
  title: string
  company: string
  companyUrl?: string
  location?: string
  remoteType?: 'remote' | 'hybrid' | 'onsite'
  salaryMin?: number
  salaryMax?: number
  salaryCurrency?: string
  description?: string
  url?: string
  tags?: string[]
  expiresAt?: string
  /** The employer's application form, when the source knows it (ATS boards do). */
  applyUrl?: string
  atsType?: AtsType
  /** Board token, posting id, structured pay, anything enrichment needs from the ATS. Stored as JSON. */
  atsMeta?: Record<string, unknown>
}

export interface SearchParams {
  keywords: string[]
  excludedKeywords?: string[]
  locations?: string[]
  remoteOnly?: boolean
  salaryMin?: number
  salaryCurrency?: string
}

export interface JobSourceAdapter {
  name: string
  /**
   * Returns the listings that match the params. Throws when the source fails, so the
   * search run can record which sources worked. Throw SourceUnavailable for a known,
   * lasting condition (missing key, no subscription) that should not read as an outage.
   */
  search(params: SearchParams): Promise<NormalizedJob[]>
}

/** A source that cannot run for a known reason, such as missing credentials or an inactive subscription. */
export class SourceUnavailable extends Error {
  constructor(public readonly source: string, reason: string) {
    super(reason)
    this.name = 'SourceUnavailable'
  }
}

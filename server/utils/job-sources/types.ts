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
  search(params: SearchParams): Promise<NormalizedJob[]>
}

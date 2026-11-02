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

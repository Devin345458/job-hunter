import { ACCOUNT_REQUIRED_ATS, type AtsType } from '#shared/types/pipeline'

// ATS detection from a URL, and the URL of the application form for each ATS we handle.

const HOST_RULES: Array<{ ats: AtsType; test: (u: URL) => boolean }> = [
  // The sandbox posting page (/sandbox/jobs/<token>) and its form (/sandbox/apply/<token>).
  { ats: 'sandbox', test: u => /^\/sandbox\/(apply|jobs)\//.test(u.pathname) },
  { ats: 'greenhouse', test: u => /(^|\.)greenhouse\.io$/.test(u.hostname) },
  { ats: 'lever', test: u => /(^|\.)lever\.co$/.test(u.hostname) },
  { ats: 'ashby', test: u => /(^|\.)ashbyhq\.com$/.test(u.hostname) },
  { ats: 'workable', test: u => /(^|\.)workable\.com$/.test(u.hostname) },
  { ats: 'smartrecruiters', test: u => /(^|\.)smartrecruiters\.com$/.test(u.hostname) },
  { ats: 'recruitee', test: u => /(^|\.)recruitee\.com$/.test(u.hostname) },
  { ats: 'bamboohr', test: u => /(^|\.)bamboohr\.com$/.test(u.hostname) },
  { ats: 'jobvite', test: u => /(^|\.)jobvite\.com$/.test(u.hostname) },
  { ats: 'workday', test: u => /(^|\.)(myworkdayjobs|workday|myworkdaysite)\.com$/.test(u.hostname) },
  { ats: 'icims', test: u => /(^|\.)icims\.com$/.test(u.hostname) },
  { ats: 'taleo', test: u => /(^|\.)taleo\.net$/.test(u.hostname) },
  { ats: 'successfactors', test: u => /successfactors\.(com|eu)$/.test(u.hostname) || /(^|\.)sapsf\.(com|eu)$/.test(u.hostname) },
]

export function atsFromUrl(url: string | null | undefined): AtsType {
  if (!url) return 'unknown'
  try {
    const u = new URL(url)
    return HOST_RULES.find(r => r.test(u))?.ats ?? 'other'
  }
  catch {
    return 'unknown'
  }
}

export function requiresAccount(ats: AtsType | string | null | undefined): boolean {
  return !!ats && (ACCOUNT_REQUIRED_ATS as readonly string[]).includes(ats)
}

export const ATS_LABELS: Record<AtsType, string> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
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
  other: 'Company site',
  unknown: 'Unknown',
}

/**
 * The URL that shows the application form itself, when the listing URL points at the posting:
 * - Sandbox: /sandbox/jobs/<token> becomes /sandbox/apply/<token>
 * - Lever: jobs.lever.co/<co>/<id> becomes jobs.lever.co/<co>/<id>/apply
 * - Ashby: jobs.ashbyhq.com/<org>/<id> becomes jobs.ashbyhq.com/<org>/<id>/application
 * - Workable: apply.workable.com/<co>/j/<code>/ becomes .../apply/
 * - Greenhouse: the embed URL boards.greenhouse.io/embed/job_app?for=<token>&token=<id> shows only the form
 */
export function formUrlFor(url: string, ats: AtsType): string {
  try {
    const u = new URL(url)
    if (ats === 'sandbox') {
      // Sandbox jobs enriched before 2026-11-01 point at the posting page; the form is one link away.
      const m = u.pathname.match(/^\/sandbox\/jobs\/([^/]+)\/?$/)
      if (m) u.pathname = `/sandbox/apply/${m[1]}`
    }
    if (ats === 'lever' && u.hostname === 'jobs.lever.co') {
      const parts = u.pathname.split('/').filter(Boolean)
      if (parts.length === 2) u.pathname = `/${parts[0]}/${parts[1]}/apply`
    }
    if (ats === 'ashby' && u.hostname === 'jobs.ashbyhq.com') {
      const parts = u.pathname.split('/').filter(Boolean)
      if (parts.length === 2) u.pathname = `/${parts[0]}/${parts[1]}/application`
    }
    if (ats === 'workable' && u.hostname === 'apply.workable.com') {
      const parts = u.pathname.split('/').filter(Boolean)
      if (parts.length === 3 && parts[1] === 'j') u.pathname = `/${parts[0]}/j/${parts[2]}/apply/`
    }
    if (ats === 'greenhouse' && u.hostname === 'boards.greenhouse.io') {
      // boards.greenhouse.io/<token>/jobs/<id> redirects to job-boards; keep it as is.
      const m = u.pathname.match(/^\/embed\/job_app/)
      if (m) return u.toString()
    }
    return u.toString()
  }
  catch {
    return url
  }
}

/** Frame URLs that hold an ATS application form embedded in a company careers page. */
export function embeddedFormUrl(frameUrls: string[]): string | null {
  for (const f of frameUrls) {
    if (/greenhouse\.io\/(embed\/job_app|[^/]+\/jobs\/\d+|embed\/job_board)/.test(f) && /job_app|jobs\/\d+/.test(f)) return f
    if (/jobs\.lever\.co\/[^/]+\/[0-9a-f-]{36}/.test(f)) return f
    if (/jobs\.ashbyhq\.com\/[^/]+\/(embed|[0-9a-f-]{36})/.test(f)) return f
    if (/apply\.workable\.com\/[^/]+\/j\//.test(f)) return f
  }
  return null
}

// Number and label formatting shared by the job components.

export function formatMoney(value: number | null | undefined, currency: string | null = 'USD'): string {
  if (value == null) return ''
  const n = Math.round(value).toLocaleString('en-US')
  return !currency || /USD/i.test(currency) ? `$${n}` : `${n} ${currency}`
}

export function formatMoneyShort(value: number | null | undefined): string {
  if (value == null) return ''
  return value >= 1000 ? `$${Math.round(value / 1000)}K` : `$${Math.round(value)}`
}

export function formatRange(min: number | null | undefined, max: number | null | undefined, currency: string | null = 'USD'): string {
  if (min != null && max != null && min !== max) return `${formatMoney(min, currency)} to ${formatMoney(max, currency)}`
  if (min != null || max != null) return formatMoney(min ?? max, currency)
  return ''
}

export function scoreColor(score: number | null | undefined): string {
  if (score == null) return 'grey'
  if (score >= 80) return 'success'
  if (score >= 60) return 'warning'
  return 'error'
}

export const RECOMMENDATION_LABELS: Record<string, string> = {
  strong_match: 'Strong match',
  good_match: 'Good match',
  partial_match: 'Partial match',
  weak_match: 'Weak match',
}

export const ATS_LABELS: Record<string, string> = {
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
  other: 'Employer site',
  unknown: 'Unknown',
}

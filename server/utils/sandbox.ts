import type { H3Event } from 'h3'

// The sandbox is a throwaway employer: a job posting and an application form served by this
// app, shaped like a real ATS form. It is the only target the submit path may hit during testing.

export function sandboxToken(): string | null {
  const t = useRuntimeConfig().sandboxToken
  return t && t.length >= 16 ? t : null
}

export function assertSandboxToken(token: string | undefined) {
  const expected = sandboxToken()
  if (!expected || token !== expected) throw createError({ statusCode: 404, statusMessage: 'Not found' })
}

export function publicBaseUrl(event?: H3Event): string {
  const configured = useRuntimeConfig().publicBaseUrl
  if (configured) return configured.replace(/\/$/, '')
  if (event) {
    const url = getRequestURL(event)
    return `${url.protocol}//${url.host}`
  }
  return 'http://localhost:3000'
}

export const SANDBOX_JOB = {
  title: 'Senior Full-Stack Engineer (Sandbox Test Posting)',
  company: 'Sandbox Test Co',
  location: 'Remote, United States',
  description: `Sandbox Test Co is a fictional employer used to test the job-hunter submit path. Nothing sent here reaches a real company.

About the role
We are hiring a Senior Full-Stack Engineer to build and run our customer-facing web platform. You will own features end to end, from the database schema to the Vue front end, and you will mentor two mid-level engineers.

What you will do
- Build REST APIs in Laravel and Node.js, and Vue 3 front ends with Vuetify.
- Design MySQL schemas and tune slow queries on tables with hundreds of millions of rows.
- Run CI/CD in GitHub Actions and deploy to AWS.
- Write a small Go service that ingests webhook events from our payment provider.

What you bring
- 6+ years building web applications professionally.
- Strong PHP (Laravel) and TypeScript.
- Experience with Vue 3 and the Composition API.
- Experience leading or mentoring engineers.
- Nice to have: Go in production, Kubernetes, Elasticsearch.

Compensation and benefits
- Base salary: $165,000 to $190,000 per year.
- Annual bonus target of 10% of base salary.
- Medical, dental, and vision insurance with 100% of employee premiums paid.
- 401(k) with a 4% company match.
- 25 days of paid time off plus 10 company holidays.
- $1,500 yearly learning budget and a $1,000 home office stipend.
`,
}

/** True when the URL is this app's own sandbox form with the configured token. */
export function isOwnSandbox(url: string | null | undefined): boolean {
  const token = sandboxToken()
  if (!url || !token) return false
  try {
    const u = new URL(url)
    if (u.pathname !== `/sandbox/apply/${token}`) return false
    const own = new Set(['localhost', '127.0.0.1', '::1'])
    try { own.add(new URL(publicBaseUrl()).hostname) }
    catch {}
    return own.has(u.hostname)
  }
  catch {
    return false
  }
}

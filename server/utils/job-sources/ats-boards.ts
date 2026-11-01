// Curated public job boards of companies that hire remote US software engineers.
// Every token below returned open postings, including remote engineering roles, when checked
// on 2026-11-01 (see .agent-evidence/board-probe*.tsv in the cap-match worktree).
//
// To add a company: find its board token in the careers page URL
//   Greenhouse: job-boards.greenhouse.io/<token>   Lever: jobs.lever.co/<token>   Ashby: jobs.ashbyhq.com/<token>
// then add one line here. No schema change is needed.

export type BoardAts = 'greenhouse' | 'lever' | 'ashby'

export interface AtsBoard {
  ats: BoardAts
  token: string
  company: string
}

const greenhouse: Array<[string, string]> = [
  ['gitlab', 'GitLab'],
  ['pantheon', 'Pantheon'],
  ['acquia', 'Acquia'],
  ['wikimedia', 'Wikimedia Foundation'],
  ['mozilla', 'Mozilla'],
  ['gomotive', 'Motive'],
  ['fleetio', 'Fleetio'],
  ['fourkites', 'FourKites'],
  ['platformscience', 'Platform Science'],
  ['affirm', 'Affirm'],
  ['samsara', 'Samsara'],
  ['coinbase', 'Coinbase'],
  ['reddit', 'Reddit'],
  ['grafanalabs', 'Grafana Labs'],
  ['twilio', 'Twilio'],
  ['pinterest', 'Pinterest'],
  ['chainguard', 'Chainguard'],
  ['upstart', 'Upstart'],
  ['cribl', 'Cribl'],
  ['tailscale', 'Tailscale'],
  ['toast', 'Toast'],
  ['instacart', 'Instacart'],
  ['mercury', 'Mercury'],
  ['stripe', 'Stripe'],
  ['datadog', 'Datadog'],
  ['airbnb', 'Airbnb'],
  ['dropbox', 'Dropbox'],
  ['honeycomb', 'Honeycomb'],
  ['tines', 'Tines'],
  ['discord', 'Discord'],
  ['zocdoc', 'Zocdoc'],
  ['launchdarkly', 'LaunchDarkly'],
  ['circleci', 'CircleCI'],
  ['vercel', 'Vercel'],
  ['planetscale', 'PlanetScale'],
  ['gusto', 'Gusto'],
  ['calendly', 'Calendly'],
  ['lattice', 'Lattice'],
  ['justworks', 'Justworks'],
  ['doximity', 'Doximity'],
  ['anthropic', 'Anthropic'],
  ['databricks', 'Databricks'],
]

const lever: Array<[string, string]> = [
  ['jumpcloud', 'JumpCloud'],
  ['veeva', 'Veeva Systems'],
  ['spotify', 'Spotify'],
  ['metabase', 'Metabase'],
  ['shieldai', 'Shield AI'],
  ['outreach', 'Outreach'],
  ['loadsmart', 'Loadsmart'],
  ['fundrise', 'Fundrise'],
  ['skyslope', 'SkySlope'],
  ['brilliant', 'Brilliant'],
]

const ashby: Array<[string, string]> = [
  ['supabase', 'Supabase'],
  ['posthog', 'PostHog'],
  ['sentry', 'Sentry'],
  ['zapier', 'Zapier'],
  ['jobber', 'Jobber'],
  ['appfolio', 'AppFolio'],
  ['knock', 'Knock'],
  ['companycam', 'CompanyCam'],
  ['stickermule', 'Sticker Mule'],
  ['kit', 'Kit'],
  ['patreon', 'Patreon'],
  ['substack', 'Substack'],
  ['kong', 'Kong'],
  ['plaid', 'Plaid'],
  ['ramp', 'Ramp'],
  ['vanta', 'Vanta'],
  ['temporal', 'Temporal'],
  ['1password', '1Password'],
  ['notion', 'Notion'],
  ['render', 'Render'],
  ['replit', 'Replit'],
  ['workos', 'WorkOS'],
  ['resend', 'Resend'],
  ['linear', 'Linear'],
  ['hex', 'Hex'],
  ['coder', 'Coder'],
  ['railway', 'Railway'],
  ['infisical', 'Infisical'],
  ['iterable', 'Iterable'],
  ['gorgias', 'Gorgias'],
  ['hackerone', 'HackerOne'],
  ['leandata', 'LeanData'],
  ['openai', 'OpenAI'],
  ['cohere', 'Cohere'],
]

export const ATS_BOARDS: AtsBoard[] = [
  ...greenhouse.map(([token, company]) => ({ ats: 'greenhouse' as const, token, company })),
  ...lever.map(([token, company]) => ({ ats: 'lever' as const, token, company })),
  ...ashby.map(([token, company]) => ({ ats: 'ashby' as const, token, company })),
]

export function boardsFor(ats: BoardAts): AtsBoard[] {
  return ATS_BOARDS.filter(b => b.ats === ats)
}

/** Most matching postings kept per board per run, newest first, so one large employer cannot flood the feed. */
export const MAX_PER_BOARD = 8

/** The hosted Greenhouse application form. Works even for companies whose posting lives on their own careers site. */
export function greenhouseApplyUrl(token: string, postingId: string | number) {
  return `https://job-boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(token)}&token=${encodeURIComponent(String(postingId))}`
}

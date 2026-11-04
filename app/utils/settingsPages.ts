import { PIPELINE_SCHEDULE_TEXT } from '#shared/utils/schedule'

// The Settings sub pages, one per job Devin opens Settings for. The sidebar group, the phone list
// at /settings, the app bar and tab titles, and the redirect from the old one-page anchors all read
// this list, so a title is written once. Order is the sidebar's; the first is where desktop
// /settings lands. Grouping and its reasons: .claude/context/design-system.md (2026-11-04).

export interface SettingsPageDef {
  slug: string
  title: string
  icon: string
  /** One line for the phone list: what is on the page. */
  blurb: string
  /** The page header's subtitle. */
  subtitle: string
  /** Anchors on the old single Settings page that now open this page. */
  legacyHashes?: string[]
}

export const SETTINGS_PAGES: SettingsPageDef[] = [
  {
    slug: 'pipeline',
    title: 'Pipeline',
    icon: 'mdi-pipe',
    blurb: 'Run the pipeline or one step, the queue, and the run log.',
    subtitle: `Runs ${PIPELINE_SCHEDULE_TEXT}.`,
    legacyHashes: ['#pipeline'],
  },
  {
    slug: 'claude-usage',
    title: 'Claude usage',
    icon: 'mdi-gauge',
    blurb: 'This app\'s limits on your Claude subscription and where the spend went.',
    subtitle: 'Today and the last 7 days, against this app\'s limits.',
  },
  {
    slug: 'job-search',
    title: 'Job search',
    icon: 'mdi-magnify',
    blurb: 'What to search for, and when each source was last pulled.',
    subtitle: '',
    legacyHashes: ['#job-sources'],
  },
  {
    slug: 'github-evidence',
    title: 'GitHub evidence',
    icon: 'mdi-github',
    blurb: 'The repos and identities that suggest answers from your commits.',
    subtitle: 'Only commits you authored count, and finding nothing never means No.',
    legacyHashes: ['#github-evidence'],
  },
  {
    slug: 'memory',
    title: 'Memory',
    icon: 'mdi-history',
    blurb: 'Your past Claude sessions, searched for leads on open questions.',
    subtitle: 'Your past Claude sessions on your laptop.',
    legacyHashes: ['#memory'],
  },
  {
    slug: 'api-keys',
    title: 'API keys',
    icon: 'mdi-key-outline',
    blurb: 'Which environment variables are set on this server.',
    subtitle: 'Set on the server; never sent to the browser.',
  },
]

export const settingsPath = (slug: string) => `/settings/${slug}`

/** The sub page a path belongs to, or null for /settings itself and every other route. */
export function settingsPageFor(path: string): SettingsPageDef | null {
  const m = /^\/settings\/([^/?#]+)/.exec(path)
  return m ? SETTINGS_PAGES.find(p => p.slug === m[1]) ?? null : null
}

/** Where an old /settings#anchor link now goes, or null when the hash is not one of them. */
export function settingsPathForHash(hash: string): string | null {
  const page = SETTINGS_PAGES.find(p => p.legacyHashes?.includes(hash))
  return page ? settingsPath(page.slug) : null
}

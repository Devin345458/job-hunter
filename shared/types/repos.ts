// Contract for the GitHub evidence feature (server/utils/repos, Settings > GitHub evidence, and the
// "Found in your GitHub" block on skill and experience questions).
// The rule behind every shape here: only Devin's own commits count, the system only suggests, and
// finding nothing is never a No.

/** One of Devin's commits a suggestion cites. */
export interface RepoEvidence {
  /** owner/name */
  repo: string
  sha: string
  /** https://github.com/<repo>/commit/<sha> */
  url: string
  /** Authored date, YYYY-MM-DD. */
  date: string
  /** One plain line on what the commit shows. */
  line: string
}

/** A suggested answer for a pending knows or has_done question, built from his commits. */
export interface RepoSuggestionView {
  /** Never No: no evidence means no suggestion. */
  level: 'Yes' | 'Some experience'
  /** Draft for the "Where did you do it?" box, citing only what the commits show. */
  draft: string
  evidence: RepoEvidence[]
  createdAt: string
}

export interface RepoView {
  fullName: string
  name: string
  isPrivate: boolean
  isFork: boolean
  archived: boolean
  sizeMb: number | null
  /** Switched on. A repo is on by default only when one of his own logins owns it. */
  included: boolean
  pushedAt: string | null
  htmlUrl: string | null
  indexedAt: string | null
  /** His commits found in the last index. */
  commitCount: number | null
  /** Why the last index left it out (too large, empty), in plain words. */
  skipReason: string | null
  indexError: string | null
}

export interface RepoOwnerGroup {
  owner: string
  /** Owned by one of the token logins: included by default. Every other owner is off by default. */
  personal: boolean
  ownerType: string | null
  repos: RepoView[]
}

/** What one configured read token covers. The token itself never leaves the server. */
export interface RepoTokenView {
  /** 1-based position in the configured list. */
  position: number
  /** Where it came from: NUXT_GITHUB_READ_TOKENS, NUXT_GITHUB_READ_TOKEN, or NUXT_GITHUB_TOKEN. */
  source: string
  login: string | null
  /** Owners of the repos this token can read, with counts. */
  owners: Array<{ owner: string; repos: number }>
  error: string | null
}

export interface RepoIdentities {
  /** Commit author emails that count as Devin's. */
  emails: string[]
  /** His GitHub logins. A commit counts by login when GitHub attributes it to that account or its noreply email. */
  logins: string[]
  /** False until he saves his own list; the defaults come from the knowledge base and the tokens. */
  edited: boolean
}

export interface RepoSettingsView {
  /** At least one read token is set on the server. */
  configured: boolean
  tokens: RepoTokenView[]
  groups: RepoOwnerGroup[]
  identities: RepoIdentities
  /**
   * Emails on commits that carry his login as the author name but that GitHub links to no account
   * and he has not listed. They do not count until he adds them (an old work address, a typo).
   */
  unlistedEmails: Array<{ email: string; commits: number; repos: string[] }>
  /** What the identities would be with nothing saved. */
  defaultIdentities: { emails: string[]; logins: string[] }
  listedAt: string | null
  /** Commits indexed across every included repo. */
  indexedCommits: number
  lastIndex: { id: number; status: string; startedAt: string; finishedAt: string | null } | null
  /** Shown when the list of repos could not be fetched. */
  listError: string | null
}

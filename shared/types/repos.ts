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

/**
 * One thing the question chat's GitHub search found, shown under its reply as "Found in your
 * GitHub". Built on the server from the search, never from Claude's text.
 * - commit: one of Devin's own indexed commits whose message or changed file paths matched.
 * - file: a GitHub code search hit in a switched-on repo that holds his commits. A lead only:
 *   code in a repo is not code he wrote.
 * - dependency: a package a switched-on repo declares at its default branch. Context only.
 * - language: a switched-on repo written in the language asked about. Context only.
 */
export interface GithubFinding {
  kind: 'commit' | 'file' | 'dependency' | 'language'
  /** owner/name */
  repo: string
  /** The commit, file, manifest, or repo on GitHub. */
  url: string
  /** The commit's first line, the file path, the package name, or the language. */
  title: string
  /** Authored date of a commit, YYYY-MM-DD. Null for the other kinds. */
  date: string | null
  /** What matched: "commit message" or "files: schema.graphql" (commit), 'has "shopify"' (file), or the manifest path (dependency). */
  detail: string | null
}

/** A repo where his commits change files matching the path terms, whatever their messages say. */
export interface GithubPathSummary {
  repo: string
  commits: number
  /** The matching file names his commits change most, up to three. */
  files: string[]
  /** YYYY-MM-DD */
  first: string
  last: string
}

/** What the chat's GitHub search covered, so "nothing found" says where it looked. */
export interface GithubSearchCoverage {
  /** Switched-on repos whose indexed commits were searched. */
  indexed: string[]
  /** Switched-on repos GitHub code search covered. */
  codeSearched: string[]
  /** Switched on, not indexed yet (repos:index takes 30 a run). */
  notIndexed: number
  /** Switched-on repos with his commits that code search did not reach this time (its 10-a-minute limit). */
  codeSkipped: number
  /** Repos holding his commits (by the last "Find repos with my commits") that are switched off. */
  offWithCommits: number
  /** Why code search did not run or stopped early, in plain words. Null when it ran in full. */
  codeNote: string | null
}

/** The chat's GitHub search: what it looked for, what it found, and where it looked. */
export interface GithubChatSearch {
  terms: string[]
  findings: GithubFinding[]
  pathSummaries: GithubPathSummary[]
  coverage: GithubSearchCoverage
}

export interface RepoView {
  /** His commits on the default branch, by the last "Find repos with my commits". Null before the first search. */
  yourCommits: number | null
  fullName: string
  name: string
  isPrivate: boolean
  isFork: boolean
  archived: boolean
  sizeMb: number | null
  /** Switched on. A repo is on by default only when one of his own logins owns it and it is not a fork. */
  included: boolean
  /** Set for a repo that can never be switched on (this app's own repo), saying why. */
  note: string | null
  pushedAt: string | null
  htmlUrl: string | null
  indexedAt: string | null
  /** His commits found in the last index. */
  commitCount: number | null
  /** Why the last index left it out (too large, empty), in plain words. */
  skipReason: string | null
  indexError: string | null
  /**
   * What answer text says instead of this repo's name ("car wash management software"). Null until
   * one is written (server/utils/repos/describe.ts).
   */
  description: string | null
  /** generated, or devin when he wrote or corrected it in Settings. */
  descriptionBy: 'generated' | 'devin' | null
}

export interface RepoOwnerGroup {
  owner: string
  /** Owned by one of the token logins: included by default, except forks. Every other owner is off by default. */
  personal: boolean
  ownerType: string | null
  /** Repos here holding his commits, forks left out. Null before the first search. */
  withCommits: number | null
  /** Of those, the ones still off: what "Turn on the N repos with your commits" switches on. */
  withCommitsOff: number | null
  /** GitHub refuses this owner's repos until the token is authorized for its SAML SSO. */
  sso: boolean
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
  /** Organizations GitHub left out of this token's list because they enforce SAML SSO. */
  ssoOrgs: string[]
  error: string | null
}

/** "Find repos with my commits": GitHub commit search by his logins and emails. */
export interface RepoFindView {
  /** A search is running in the server now. */
  running: boolean
  progress: { startedAt: string; requests: number; commits: number; repos: number; waitingSeconds: number | null } | null
  /** When the last good search finished. Null when none has. */
  at: string | null
  seconds: number | null
  commits: number
  /** Repos holding his commits, and how many owners they span. */
  repos: number
  owners: number
  notes: string[]
  /** The last attempt's error. The counts are then from the search before it. */
  error: string | null
  errorAt: string | null
  /** What "Turn on every repo with your commits" would switch on: off, not forks, with his commits. */
  turnOn: { repos: number; owners: number; otherOwners: string[] }
}

export interface RepoIdentities {
  /** Commit author emails that count as Devin's. */
  emails: string[]
  /** His GitHub logins. A commit counts by login when GitHub attributes it to that account or its noreply email. */
  logins: string[]
  /** False until he saves his own list. The defaults come from the knowledge base and the tokens. */
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
  /** Repos switched on, how many are indexed, and why the rest are not (yet). repos:index takes 30 a run. */
  index: { included: number; indexed: number; oversized: number; sso: number; failed: number }
  find: RepoFindView
  /** Organizations to authorize the token for (SAML SSO), from any source. */
  ssoOrgs: string[]
  lastIndex: { id: number; status: string; startedAt: string; finishedAt: string | null } | null
  /** Shown when the list of repos could not be fetched. */
  listError: string | null
}

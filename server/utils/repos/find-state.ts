// In-memory state of the commit search while it runs, read by Settings to show progress. Kept
// apart from commit-search.ts so settings.ts can read it without importing the search itself.

export interface FindProgress {
  startedAt: string
  /** Search requests sent so far. */
  requests: number
  /** Distinct commits found so far. */
  commits: number
  /** Repos holding them so far. */
  repos: number
  /** Seconds GitHub's search limit (30 a minute) is making it wait right now, else null. */
  waitingSeconds: number | null
}

let current: FindProgress | null = null

export function findProgress(): FindProgress | null {
  return current ? { ...current } : null
}

export function setFindProgress(p: FindProgress | null) {
  current = p
}

// Why a demo build stopped, when the reason is the Claude account rather than the build:
// out of credit, the key was rejected, or the daily budget ran out. runDemoBuilds retries
// those on the next daily run; any other failure waits for a manual Build again.

/** True when a demo failed only because Claude was out of credit, rejected the key, or hit the daily budget. */
export function isBudgetFailure(error: string | null | undefined): boolean {
  return stopKind(error) !== null
}

export function stopKind(error: string | null | undefined): 'credit' | 'key' | 'budget' | null {
  const e = error ?? ''
  if (/credit balance is too low|out of credit/i.test(e)) return 'credit'
  if (/rejected the key|rejected the API key|invalid x-api-key/i.test(e)) return 'key'
  if (/Daily AI budget reached|Waiting for Claude/i.test(e)) return 'budget'
  return null
}

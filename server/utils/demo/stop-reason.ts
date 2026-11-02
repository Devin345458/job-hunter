// Why a demo build stopped, when the reason is the Claude account rather than the build:
// out of credit, the key was rejected, or the daily budget ran out. runDemoBuilds retries
// those on the next pipeline run; any other failure waits for a manual Build again.
// The patterns live in shared/utils/plain-text.ts so the review card reads a stop the same way.
import { demoStopKind, type DemoStopKind } from '#shared/utils/plain-text'

/** True when a demo failed only because Claude was out of credit, rejected the key, or hit the daily budget. */
export function isBudgetFailure(error: string | null | undefined): boolean {
  return stopKind(error) !== null
}

export function stopKind(error: string | null | undefined): DemoStopKind | null {
  return demoStopKind(error)
}

// Demo builds can be switched off with NUXT_DEMOS_ENABLED=false (production, 2026-11-03, while
// the builder is stabilized locally). Switched off: demos:build and Build again do nothing, the
// review card shows no demo, and approve never publishes one. Gap analysis still runs, so the
// plan for each gap stays visible on the Demo projects page.
export const DEMOS_OFF_MESSAGE = 'Demo builds are switched off for now'

export function demosEnabled(): boolean {
  return String(useRuntimeConfig().demosEnabled ?? 'true').toLowerCase() !== 'false'
}

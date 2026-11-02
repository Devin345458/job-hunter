import type { DemoBuildProgress } from '#shared/types/pipeline'

// Demo work running in this server process: which demos are building, which are building a
// preview, and what each build is doing now. All of it lives in memory, so a restart loses
// it; runDemoBuilds marks a row left in 'building' as interrupted for that reason.

interface Live {
  phase: 'build' | 'preview'
  startedAt: number
  turn: number
  maxTurns: number
  recent: string[]
}

const RECENT_LINES = 8

const builds = new Map<number, Live>()
/** Preview builds started from the detail page (POST /api/demos/:id/preview), with their newest lines. */
const previews = new Map<number, { startedAt: number; recent: string[] }>()

export function isDemoBuilding(demoId: number): boolean {
  return builds.has(demoId)
}

/** Marks the demo as building. Returns false when it already is. */
export function claimBuild(demoId: number, maxTurns: number): boolean {
  if (builds.has(demoId)) return false
  builds.set(demoId, { phase: 'build', startedAt: Date.now(), turn: 0, maxTurns, recent: [] })
  return true
}

export function releaseBuild(demoId: number) {
  builds.delete(demoId)
}

function pushLine(recent: string[], line: string) {
  recent.push(line.length > 300 ? `${line.slice(0, 297)}...` : line)
  if (recent.length > RECENT_LINES) recent.splice(0, recent.length - RECENT_LINES)
}

export function noteBuildLine(demoId: number, line: string) {
  const live = builds.get(demoId)
  if (live) pushLine(live.recent, line)
}

export function notePreviewLine(demoId: number, line: string) {
  const live = previews.get(demoId)
  if (live) pushLine(live.recent, line)
}

export function noteBuildTurn(demoId: number, turn: number) {
  const live = builds.get(demoId)
  if (live) live.turn = turn
}

export function setBuildPhase(demoId: number, phase: 'build' | 'preview') {
  const live = builds.get(demoId)
  if (live) live.phase = phase
}

export function buildProgress(demoId: number): DemoBuildProgress | null {
  const live = builds.get(demoId)
  if (!live) {
    const preview = previews.get(demoId)
    if (!preview) return null
    return { phase: 'preview', startedAt: new Date(preview.startedAt).toISOString(), turn: 0, maxTurns: 0, recent: [...preview.recent] }
  }
  return { phase: live.phase, startedAt: new Date(live.startedAt).toISOString(), turn: live.turn, maxTurns: live.maxTurns, recent: [...live.recent] }
}

export function isPreviewBuilding(demoId: number): boolean {
  return previews.has(demoId)
}

/** Marks a preview build as running. Returns false when one already is. */
export function claimPreview(demoId: number): boolean {
  if (previews.has(demoId)) return false
  previews.set(demoId, { startedAt: Date.now(), recent: [] })
  return true
}

export function releasePreview(demoId: number) {
  previews.delete(demoId)
}

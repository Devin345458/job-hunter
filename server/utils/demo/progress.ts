import type { DemoBuildProgress } from '#shared/types/pipeline'

// Demo work running in this server process: which demos are building, which are building a
// preview, and what each build is doing now. It lives in memory, so a restart loses it;
// runDemoBuilds marks a row left in 'building' as interrupted for that reason. Every change is
// also shared on the running queue item (shareProgress), so a web process that runs no worker
// (NUXT_ROLE=web) can show it, and a rebuild or preview still waiting in the queue reads as
// waiting.

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
  share(demoId)
  return true
}

export function releaseBuild(demoId: number) {
  builds.delete(demoId)
  share(demoId)
}

/** Writes this demo's progress to the queue item running it (at most once a second). */
function share(demoId: number) {
  try {
    shareProgress(`demo:${demoId}`, localProgress(demoId))
  }
  catch {}
}

function pushLine(recent: string[], line: string) {
  recent.push(line.length > 300 ? `${line.slice(0, 297)}...` : line)
  if (recent.length > RECENT_LINES) recent.splice(0, recent.length - RECENT_LINES)
}

export function noteBuildLine(demoId: number, line: string) {
  const live = builds.get(demoId)
  if (live) pushLine(live.recent, line)
  share(demoId)
}

export function notePreviewLine(demoId: number, line: string) {
  const live = previews.get(demoId)
  if (live) pushLine(live.recent, line)
  share(demoId)
}

export function noteBuildTurn(demoId: number, turn: number) {
  const live = builds.get(demoId)
  if (live) live.turn = turn
  share(demoId)
}

export function setBuildPhase(demoId: number, phase: 'build' | 'preview') {
  const live = builds.get(demoId)
  if (live) live.phase = phase
  share(demoId)
}

/**
 * What a demo's build or preview is doing now: live progress from this process, else from the
 * worker process (web role), else "waiting" while a rebuild or preview for it is in the queue.
 */
export function buildProgress(demoId: number): DemoBuildProgress | null {
  const local = localProgress(demoId)
  if (local) return local
  try {
    const shared = runsWorker() ? null : sharedProgress<DemoBuildProgress>(`demo:${demoId}`)
    if (shared) return shared
    const queued = activeItem([REBUILD_TASK, PREVIEW_TASK], 'demoId', demoId)
    if (queued?.status === 'queued') {
      return {
        phase: queued.task === PREVIEW_TASK ? 'preview' : 'build',
        startedAt: new Date(`${queued.createdAt.replace(' ', 'T')}Z`).toISOString(),
        turn: 0,
        maxTurns: 0,
        recent: [],
        waiting: waitingText(),
      }
    }
  }
  catch {}
  return null
}

function localProgress(demoId: number): DemoBuildProgress | null {
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
  share(demoId)
  return true
}

export function releasePreview(demoId: number) {
  previews.delete(demoId)
  share(demoId)
}

/**
 * True while this demo builds or builds a preview anywhere: in this process, in the worker
 * process, or waiting in the queue. The rebuild and preview routes answer 409 then.
 */
export function demoBusy(demoId: number, status?: string): boolean {
  if (builds.has(demoId) || previews.has(demoId)) return true
  if (activeItem([REBUILD_TASK, PREVIEW_TASK], 'demoId', demoId)) return true
  if (runsWorker()) return false
  // Web role: the worker process is building it (its progress, or the daily demos:build running).
  if (sharedProgress(`demo:${demoId}`)) return true
  return status === 'building' && activeItem('demos:build')?.status === 'running'
}

/** A preview that is building in any process, or waiting in the queue. */
export function previewBusy(demoId: number): boolean {
  if (previews.has(demoId)) return true
  const item = activeItem(PREVIEW_TASK, 'demoId', demoId)
  return !!item
}

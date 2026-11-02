import { isCreditError } from './plain-text'
import { properName, properNamesIn } from './names'

// One outcome per pipeline run, derived from what the run recorded. A run that finished without
// throwing is not automatically a success: a step that scored 0 of 38 jobs, or stopped because
// Claude was out of credit, finished "succeeded" in pipeline_runs. The dashboard shows those as
// partial, in amber, with the problem said in a few words.

export type RunOutcome = 'running' | 'succeeded' | 'partial' | 'failed' | 'skipped'

export const TASK_LABELS: Record<string, string> = {
  'pipeline:daily': 'Full run',
  'learn:daily': 'Learn from decisions',
  'jobs:search': 'Search listings',
  'jobs:enrich': 'Read postings',
  'jobs:match': 'Score matches',
  'applications:prepare': 'Prepare applications',
  'demos:build': 'Build demo projects',
  // Started from a demo's page, one demo at a time.
  'demos:rebuild': 'Rebuild a demo',
  'demos:preview': 'Build a demo preview',
  'system:heartbeat': 'Scheduler heartbeat',
}

export function taskLabel(task: string): string {
  return TASK_LABELS[task] ?? task.replace(/[:_]/g, ' ')
}

interface RunLike {
  task: string
  status: string
  stats: Record<string, unknown> | null
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** True when most of a run's recorded errors are Anthropic credit refusals. */
function creditErrors(stats: Record<string, unknown>): boolean {
  const errors: string[] = []
  if (Array.isArray(stats.errors)) errors.push(...stats.errors.filter((e): e is string => typeof e === 'string'))
  if (Array.isArray(stats.results)) {
    for (const r of stats.results as Array<{ error?: unknown }>) if (typeof r?.error === 'string') errors.push(r.error)
  }
  return errors.length > 0 && errors.filter(isCreditError).length * 2 >= errors.length
}

/**
 * The problems one run recorded, each a few plain words ("38 failed, Claude is out of credit",
 * "stopped: out of credit"). Empty for a clean run. pipeline:daily runs list their steps' problems,
 * from the problems they recorded or, for runs recorded before that, from their chained steps.
 * Source ids are written as product names here, so a problem stored as "adzuna search failed"
 * on an old run reads "Adzuna search failed" too.
 */
export function runProblems(run: RunLike, children: RunLike[] = []): string[] {
  const stats = run.stats ?? {}
  if (run.task === 'pipeline:daily') {
    const recorded = stats.problems as Record<string, string[]> | undefined
    const steps = stats.steps as Record<string, unknown> | undefined
    const out: string[] = []
    if (recorded && typeof recorded === 'object') {
      for (const [step, list] of Object.entries(recorded)) {
        for (const p of Array.isArray(list) ? list : []) out.push(`${taskLabel(step)}: ${p}`)
      }
    }
    else {
      for (const child of children) {
        for (const p of runProblems(child)) out.push(`${taskLabel(child.task)}: ${p}`)
      }
    }
    // A step that threw or was skipped, whichever shape the steps were recorded in.
    for (const [step, value] of Object.entries(steps ?? {})) {
      const status = typeof value === 'string' ? value : (value as { status?: string } | null)?.status
      if (status === 'failed' || status === 'skipped') out.push(`${taskLabel(step)}: ${status}`)
    }
    return [...new Set(out.map(properNamesIn))]
  }

  const out: string[] = []
  const failed = num(stats.failed)
  if (failed > 0) out.push(creditErrors(stats) ? `${failed} failed, Claude is out of credit` : `${failed} failed`)
  if (stats.budgetStop === true || stats.budgetStopped === true) {
    out.push(stats.stopReason === 'key'
      ? 'stopped: Anthropic rejected the API key'
      : stats.stopReason === 'credit' ? 'stopped: out of credit' : 'stopped: daily AI budget reached')
  }
  if (num(stats.noteErrors) > 0) out.push(`${num(stats.noteErrors)} rejection note${num(stats.noteErrors) === 1 ? '' : 's'} not read`)
  if (num(stats.interrupted) > 0) out.push(`${num(stats.interrupted)} interrupted`)
  const sources = stats.sources as Record<string, { status?: string }> | undefined
  if (sources && typeof sources === 'object') {
    const down = Object.entries(sources).filter(([, s]) => s?.status === 'failed').map(([name]) => name)
    if (down.length) out.push(`${down.map(properName).join(', ')} search failed`)
  }
  return out.map(properNamesIn)
}

/** Failed when the run threw, partial when it finished with problems, otherwise its status. */
export function runOutcome(run: RunLike, problems: string[]): RunOutcome {
  if (run.status === 'failed') return 'failed'
  if (run.status === 'running') return 'running'
  if (run.status === 'skipped') return 'skipped'
  return problems.length ? 'partial' : 'succeeded'
}

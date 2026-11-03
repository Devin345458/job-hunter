import type { QueueItemView, QueueSnapshot } from '../types/pipeline'

// Queue items in plain words, for the run log and the Review page:
// "Waiting: Score matches, queued 2 minutes ago"
// "Running: Read postings (full run, step 4 of 9), resumed after a restart"
// "Interrupted: Submit an approved application: Acme, 5 minutes ago. Check the employer's site ..."

function parse(value: string | null | undefined): number | null {
  if (!value) return null
  const t = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`)
  return Number.isFinite(t) ? t : null
}

/** "just now", "1 minute ago", "3 minutes ago", "2 hours ago". */
export function minutesAgo(value: string | null | undefined, now: number = Date.now()): string {
  const t = parse(value)
  if (t == null) return ''
  const mins = Math.floor((now - t) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} ${mins === 1 ? 'minute' : 'minutes'} ago`
  const hours = Math.floor(mins / 60)
  return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
}

/** The label with its place in a daily run: "Score matches (full run, step 5 of 9)". */
export function queueItemName(item: QueueItemView): string {
  return item.step ? `${item.label} (full run, step ${item.step.index} of ${item.step.total})` : item.label
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)

export function queueItemText(item: QueueItemView, now: number = Date.now()): string {
  const name = queueItemName(item)
  const resumed = item.attempts > 0
  switch (item.status) {
    case 'queued':
      return resumed
        ? `Waiting to resume: ${name}, stopped by a restart`
        : `Waiting: ${name}, queued ${minutesAgo(item.createdAt, now)}`
    case 'running':
      if (item.task === 'pipeline:daily' && item.step == null && !item.startedAt) return `Running: ${name}`
      return `Running: ${name}, started ${minutesAgo(item.startedAt, now)}${resumed ? `, ${lower(item.note || 'resumed after a restart')}` : ''}`
    case 'interrupted':
      return `Interrupted: ${name}, ${minutesAgo(item.finishedAt, now)}.${item.error ? ` ${item.error}` : ''}`
    case 'failed':
      return `Failed: ${name}, ${minutesAgo(item.finishedAt, now)}.${item.error ? ` ${item.error}` : ''}`
    case 'canceled':
      return `Canceled: ${name}, ${minutesAgo(item.finishedAt, now)}`
    case 'done':
      return `Done: ${name}, ${minutesAgo(item.finishedAt, now)}${resumed ? ', resumed after a restart' : ''}`
  }
  return name
}

/** The color a queue item's dot takes, in the run log's palette. */
export function queueItemColor(item: QueueItemView): string {
  if (item.status === 'running') return 'info'
  if (item.status === 'interrupted' || item.status === 'failed') return 'error'
  if (item.status === 'done') return 'success'
  return 'secondary'
}

const BULK_VERB: Record<string, string> = {
  'jobs:enrich-one': 'Reading postings',
  'jobs:match-one': 'Scoring jobs',
}

/** Per-job items in one line: "Reading postings: 4 now, 37 waiting". */
export function bulkText(b: QueueSnapshot['bulk'][number]): string {
  const verb = BULK_VERB[b.task] ?? b.label
  const parts = [b.running ? `${b.running} now` : null, b.waiting ? `${b.waiting} waiting` : null].filter(Boolean)
  return `${verb}: ${parts.join(', ')}`
}

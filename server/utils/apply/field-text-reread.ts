import { eq, inArray, isNotNull, and } from 'drizzle-orm'
import { applications, appSettings, jobs } from '../../db/schema'
import type { FormField, FormSnapshot } from '#shared/types/pipeline'
import { cleanFieldLabel } from '#shared/utils/plain-text'
import { nowSql, parseJson } from '../review'
import { atsFromUrl } from './ats'
import { openForm } from './engine'
import { refersElsewhere } from './field-text'

// Once after the 2026-11-05 deploy: forms read before the reader kept each field's own text
// (FormField.description) lost the text a label points at ("I have marked the sender address
// above as safe" with the address above it). Each open application with such a label has its
// form read again in Chromium, read only (no fill, no submit, no upload), and the descriptions are
// copied onto its stored fields. Nothing else changes: no field id, label, or answer, no question,
// no status. No Claude call. It runs at the start of applications:read-forms, which holds the heavy
// slot, so it never opens Chromium beside a preparation or a submit.

export const FIELD_TEXT_REREAD_KEY = 'form_field_text_reread'

/** Applications whose snapshot still matters: Decide cards and the ones waiting on answers or approval. */
const OPEN_STATUSES = ['to_decide', 'needs_input', 'proposed']

interface RereadState {
  done: boolean
  /** Applications already read again (or tried), so a restart continues where it stopped. */
  tried: number[]
  reread: number
  fieldsGained: number
  failed: Array<{ applicationId: number; error: string }>
  at?: string
}

function readState(): RereadState | null {
  const row = useDb().select({ v: appSettings.valueJson }).from(appSettings).where(eq(appSettings.key, FIELD_TEXT_REREAD_KEY)).get()
  return row ? parseJson<RereadState | null>(row.v, null) : null
}

function writeState(state: RereadState) {
  const db = useDb()
  const value = JSON.stringify(state)
  db.insert(appSettings).values({ key: FIELD_TEXT_REREAD_KEY, valueJson: value, updatedAt: nowSql() })
    .onConflictDoUpdate({ target: appSettings.key, set: { valueJson: value, updatedAt: nowSql() } }).run()
}

/** A stored field that points at text it does not hold and has no description yet. */
export function needsFieldText(f: FormField): boolean {
  return f.type !== 'file' && !f.description && refersElsewhere(f.label)
}

/** Open applications with at least one such field. */
export function fieldTextRereadCandidates(): Array<{ applicationId: number; jobId: number; applyUrl: string | null; atsType: string | null; fields: string[] }> {
  return useDb().select({ app: applications, job: jobs }).from(applications)
    .innerJoin(jobs, eq(applications.jobId, jobs.id))
    .where(and(inArray(applications.status, OPEN_STATUSES), isNotNull(applications.formSnapshotJson)))
    .all()
    .map(({ app, job }) => ({
      applicationId: app.id,
      jobId: job.id,
      applyUrl: job.applyUrl,
      atsType: job.atsType,
      fields: (parseJson<FormSnapshot | null>(app.formSnapshotJson, null)?.fields ?? []).filter(needsFieldText).map(f => f.id),
    }))
    .filter(c => c.fields.length > 0)
}

const labelKey = (f: Pick<FormField, 'label' | 'type'>) => `${f.type}|${cleanFieldLabel(f.label).toLowerCase()}`

/**
 * Copies descriptions from a fresh read onto stored fields, matched by selector, then by label
 * and type. Returns how many stored fields gained one. Never changes anything else on a field.
 */
export function mergeFieldText(stored: FormField[], fresh: FormField[]): number {
  let gained = 0
  const bySelector = new Map(fresh.map(f => [f.selector, f]))
  const byLabel = new Map<string, FormField>()
  for (const f of fresh) if (!byLabel.has(labelKey(f))) byLabel.set(labelKey(f), f)
  for (const f of stored) {
    if (f.description || f.type === 'file') continue
    const match = bySelector.get(f.selector) ?? byLabel.get(labelKey(f))
    if (match?.description) {
      f.description = match.description
      gained++
    }
  }
  return gained
}

export interface FieldTextRereadResult {
  ran: boolean
  candidates: number
  reread: number
  fieldsGained: number
  failed: Array<{ applicationId: number; error: string }>
}

/**
 * Reads the forms once. A second call after it finished does nothing; one cut off by a restart
 * continues with the applications it had not tried.
 */
export async function rereadFieldTextOnce(log: (m: string) => void = () => {}): Promise<FieldTextRereadResult> {
  const prior = readState()
  if (prior?.done) return { ran: false, candidates: 0, reread: prior.reread, fieldsGained: prior.fieldsGained, failed: prior.failed }
  const state: RereadState = prior ?? { done: false, tried: [], reread: 0, fieldsGained: 0, failed: [] }
  const candidates = fieldTextRereadCandidates()
  const todo = candidates.filter(c => !state.tried.includes(c.applicationId))
  log(`form field text: ${candidates.length} open ${candidates.length === 1 ? 'application has' : 'applications have'} a label that points at text the stored form lacks; reading ${todo.length} again`)
  writeState(state)

  for (const c of todo) {
    state.tried.push(c.applicationId)
    if (!c.applyUrl) {
      writeState(state)
      continue
    }
    let opened: Awaited<ReturnType<typeof openForm>> | null = null
    try {
      opened = await openForm(c.applyUrl, (c.atsType as any) || atsFromUrl(c.applyUrl))
      const fresh = opened.snapshot.fields
      // Read the row again: the answers or the snapshot may have changed while Chromium loaded.
      const row = useDb().select({ snap: applications.formSnapshotJson }).from(applications).where(eq(applications.id, c.applicationId)).get()
      const snapshot = parseJson<FormSnapshot | null>(row?.snap, null)
      if (!snapshot || fresh.length === 0) throw new Error(fresh.length === 0 ? 'the form showed no fields' : 'the stored form is gone')
      const gained = mergeFieldText(snapshot.fields, fresh)
      if (gained > 0) {
        useDb().update(applications).set({ formSnapshotJson: JSON.stringify(snapshot) }).where(eq(applications.id, c.applicationId)).run()
      }
      state.reread++
      state.fieldsGained += gained
      const pointing = snapshot.fields.filter(f => c.fields.includes(f.id))
      log(`form field text: application ${c.applicationId}: ${gained} ${gained === 1 ? 'field' : 'fields'} gained the form's text${pointing.length ? `; ${pointing.filter(f => f.description).length} of ${pointing.length} pointing labels now have it` : ''}`)
    }
    catch (e: any) {
      const error = String(e?.message || e).split('\n')[0]!.slice(0, 200)
      state.failed.push({ applicationId: c.applicationId, error })
      log(`form field text: application ${c.applicationId}: could not read the form again (${error}); its stored form is unchanged`)
    }
    finally {
      await opened?.context.close().catch(() => {})
    }
    writeState(state)
  }

  state.done = true
  state.at = new Date().toISOString()
  writeState(state)
  log(`form field text: read ${state.reread} ${state.reread === 1 ? 'form' : 'forms'} again, ${state.fieldsGained} ${state.fieldsGained === 1 ? 'field' : 'fields'} gained the form's text, ${state.failed.length} could not be read`)
  return { ran: true, candidates: candidates.length, reread: state.reread, fieldsGained: state.fieldsGained, failed: state.failed }
}

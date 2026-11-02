import { eq } from 'drizzle-orm'
import { knowledgeEntries } from '../db/schema'
import type { InferSelectModel } from 'drizzle-orm'

export type KnowledgeEntry = InferSelectModel<typeof knowledgeEntries>

/**
 * Knowledge base rows with duplicates collapsed. The production database holds every
 * seeded row three times; reads keep the most recently updated row per (category, key)
 * and never delete anything.
 */
export function loadKnowledge(category?: string): KnowledgeEntry[] {
  const db = useDb()
  const rows = category
    ? db.select().from(knowledgeEntries).where(eq(knowledgeEntries.category, category)).all()
    : db.select().from(knowledgeEntries).all()
  const byKey = new Map<string, KnowledgeEntry>()
  for (const row of rows) {
    const k = `${row.category}\u0000${row.key.trim().toLowerCase()}`
    const prev = byKey.get(k)
    if (!prev || row.updatedAt > prev.updatedAt || (row.updatedAt === prev.updatedAt && row.id > prev.id)) {
      byKey.set(k, row)
    }
  }
  return [...byKey.values()].sort((a, b) => a.id - b.id)
}

/** Map of "category/key" to value, the format the prompts already use. */
export function knowledgeMap(entries = loadKnowledge()): Record<string, string> {
  const map: Record<string, string> = {}
  for (const e of entries) map[`${e.category}/${e.key}`] = e.value
  return map
}

/** Case-insensitive lookup of a profile field such as "Full Name" or "email". */
export function profileValue(entries: KnowledgeEntry[], ...keys: string[]): string | undefined {
  const wanted = keys.map(k => k.toLowerCase().replace(/[\s_-]+/g, ''))
  const hit = entries.find(e => e.category === 'profile' && wanted.includes(e.key.toLowerCase().replace(/[\s_-]+/g, '')))
  return hit?.value || undefined
}

export function candidateContact(entries = loadKnowledge()) {
  return {
    name: profileValue(entries, 'Full Name', 'name') || 'Candidate',
    contact: {
      email: profileValue(entries, 'Email'),
      phone: profileValue(entries, 'Phone'),
      // Location ("Columbus, OH") before City, whichever row is older.
      location: profileValue(entries, 'Location') ?? profileValue(entries, 'City'),
      linkedin: profileValue(entries, 'LinkedIn'),
      github: profileValue(entries, 'GitHub'),
    },
  }
}

/** Insert or update one entry by (category, key). Updates every duplicate row so they stay consistent. */
export function upsertKnowledge(category: string, key: string, value: string, source = 'user_answer'): KnowledgeEntry {
  const db = useDb()
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const existing = db.select().from(knowledgeEntries).where(eq(knowledgeEntries.category, category)).all()
    .filter(r => r.key.trim().toLowerCase() === key.trim().toLowerCase())
  if (existing.length > 0) {
    for (const row of existing) {
      db.update(knowledgeEntries).set({ value, source, updatedAt: now }).where(eq(knowledgeEntries.id, row.id)).run()
    }
    return { ...existing[existing.length - 1]!, value, source, updatedAt: now }
  }
  return db.insert(knowledgeEntries).values({ category, key, value, source }).returning().get()
}

/**
 * Writes an entry only when its value would change, so a task that runs every day leaves the
 * knowledge base (and every updated_at) alone when it has nothing new to say. With
 * `onlyIfMissing`, an existing entry is never touched, whatever it holds.
 * Returns the entry and whether anything was written.
 */
export function setKnowledgeIfChanged(category: string, key: string, value: string, source = 'user_answer', opts: { onlyIfMissing?: boolean } = {}): { entry: KnowledgeEntry; written: boolean } {
  const existing = loadKnowledge(category).find(e => e.key.trim().toLowerCase() === key.trim().toLowerCase())
  // The same value from a different source is still written: Devin restating an inferred city makes it his answer.
  if (existing && (opts.onlyIfMissing || (existing.value === value && existing.source === source))) return { entry: existing, written: false }
  return { entry: upsertKnowledge(category, key, value, source), written: true }
}

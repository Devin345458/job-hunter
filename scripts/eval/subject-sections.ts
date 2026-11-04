// Checks how skill and experience answers are filed and carried (server/utils/questions.ts:
// subjectSection, carryAnswerFrom, refileSubjectSectionsOnce) on a COPY of a production snapshot,
// without calling Claude. It writes to the copy: never point it at the live database.
//
//   npx tsx --tsconfig scripts/eval/tsconfig.json scripts/eval/subject-sections.ts <snapshotCopy.db>
//
// Prints the classifier's verdict for fixed subjects, runs the one-time repair and lists every
// question it answered or moved, then asks a new knows question about Docker and shows which row
// comes back. Exits 1 when a verdict differs from the expected one.

import { setupGlobals } from './globals'

const [dbPath] = process.argv.slice(2)
if (!dbPath) {
  console.error('usage: subject-sections.ts <snapshotCopy.db>')
  process.exit(2)
}
await setupGlobals({ databasePath: dbPath, anthropicApiKey: '', aiModel: 'none', aiFallbackModel: 'none', dailyAiBudgetUsd: '0', schedulerEnabled: 'false', demoToolPath: '' })
const q = await import('../../server/utils/questions')
const { questions, knowledgeEntries, aiCalls } = await import('../../server/db/schema')
const { inArray, eq, sql } = await import('drizzle-orm')
const db = (globalThis as any).useDb()

let failed = 0
const expect = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`)
}

console.log('\n== Sections')
const cases: Array<[string, string, boolean | null, string]> = [
  ['Docker containerization', 'has_done', null, 'skill'],
  ['Docker', 'knows', true, 'skill'],
  ['Fintech or financial services', 'has_done', false, 'experience'],
  ['Fintech or lending knowledge', 'has_done', false, 'experience'],
  ['Payments and reconciliation', 'has_done', false, 'experience'],
  ['24/7 on-call rotation', 'has_done', false, 'experience'],
  ['Startup experience', 'has_done', false, 'experience'],
  ['Incident management, logging, monitoring, and observability', 'has_done', null, 'experience'],
  ['GitHub', 'knows', false, 'skill'],
  ['Figma or Sketch', 'knows', false, 'skill'],
  ['Python3', 'knows', null, 'skill'],
  ['FastAPI', 'knows', null, 'skill'],
]
for (const [subject, kind, flag, want] of cases) expect(`${kind} "${subject}" (codeShowable ${flag})`, q.subjectSection(subject, kind, flag), want)
expect('key of Docker containerization', q.subjectTarget('Docker containerization', 'has_done'), { category: 'skill', key: 'Docker' })
expect('key of Python3', q.subjectTarget('Python3', 'knows'), { category: 'skill', key: 'Python' })
expect('Python and FastAPI stay apart', q.skillCore('Python') === q.skillCore('FastAPI'), false)

const show = (ids: number[]) => db.select({ id: questions.id, kind: questions.kind, subject: questions.subject, status: questions.status, answer: questions.answer, knowledgeKey: questions.knowledgeKey, context: questions.context })
  .from(questions).where(inArray(questions.id, ids)).all()
  .map((r: any) => ({ ...r, context: (r.context ?? '').slice(0, 110) }))
const entry = (id: number) => db.select().from(knowledgeEntries).where(eq(knowledgeEntries.id, id)).get()

const WATCH = [186, 346, 345, 273, 351, 161, 191]
const aiBefore = db.select({ n: sql<number>`count(*)` }).from(aiCalls).get().n
const valueBefore = { 183: entry(183)?.value, 184: entry(184)?.value }
console.log('\n== Before the repair')
console.table(show(WATCH))

console.log('\n== Repair')
const repair = q.refileSubjectSectionsOnce(m => console.log(m))
console.log('entries moved:', repair.entries)
console.log('entries kept:', repair.kept)
console.log('questions re-filed:', repair.questions.length)
for (const r of repair.questions) console.log(`  #${r.id}: ${r.from} -> ${r.to}`)
console.log('answered from another answer:', repair.answered)

console.log('\n== After the repair')
console.table(show(WATCH))
const after = show(WATCH)
const byId = (id: number) => after.find((r: any) => r.id === id)
expect('#186 answered', byId(186)?.status, 'answered')
expect('#186 answer', byId(186)?.answer, 'Yes')
expect('#186 note', byId(186)?.context.startsWith('Answered from your answer to #346'), true)
expect('#273 answer', byId(273)?.answer, 'No')
expect('#273 note', byId(273)?.context.startsWith('Answered from your answer to #345'), true)
expect('#161 still pending', byId(161)?.status, 'pending')
expect('#191 still pending', byId(191)?.status, 'pending')
expect('#351 (interest) still pending', byId(351)?.status, 'pending')
expect('entry 183 section', [entry(183)?.category, entry(183)?.key], ['skill', 'Docker'])
expect('entry 184 section', [entry(184)?.category, entry(184)?.key], ['experience', 'Has done: Fintech or financial services'])
expect('entry 183 value unchanged', entry(183)?.value === valueBefore[183], true)
expect('entry 184 value unchanged', entry(184)?.value === valueBefore[184], true)
const q346 = db.select().from(questions).where(eq(questions.id, 346)).get()
expect('#346 example still reads', (q.questionExample(q346) ?? '').slice(0, 30), (valueBefore[183] ?? '').split(' Example: ')[1]?.slice(0, 30))

console.log('\n== A new knows question about Docker')
const asked = q.askQuestion({ question: 'Have you used Docker in a real project?', kind: 'knows', subject: 'Docker', answerType: 'yes_no', context: 'Check script.' })
console.log(`askQuestion(knows, Docker) returned #${asked.id} (${asked.status}, ${asked.answer})`)
expect('reuses an existing question', asked.id <= 363, true)
expect('askKnows(Docker) asks nothing (the knowledge base covers it)', q.askKnows('Docker'), null)

expect('#186 shows the example from #346', (q.questionExample(db.select().from(questions).where(eq(questions.id, 186)).get()) ?? '').slice(0, 30), (valueBefore[183] ?? '').split(' Example: ')[1]?.slice(0, 30))

console.log('\n== A fresh Yes on Python (as if Devin answered #147)')
db.update(questions).set({ status: 'answered', answer: 'Yes', answeredAt: sql`datetime('now')`, knowledgeKey: 'skill:Python' }).where(eq(questions.id, 147)).run()
const python = q.carryAnswerFrom(147, { overwriteDirect: true })
for (const c of python) console.log(`  #${c.row.id} "${c.row.subject}" (${c.rule}) -> ${c.answer}`)
expect('carried only to Python questions', python.every(c => /python/i.test(c.row.subject ?? '') && !/fastapi|flask/i.test(c.row.subject ?? '')), true)
expect('#188 Python FastAPI stays open', db.select().from(questions).where(eq(questions.id, 188)).get()?.status, 'pending')
expect('#249 Python3 (merged) resolves to the answered #147', [q.canonicalQuestion(249)?.id, q.canonicalQuestion(249)?.status], [147, 'answered'])

console.log('\n== Second run changes nothing')
expect('repair runs once', q.refileSubjectSectionsOnce().ran, false)
expect('carry is idempotent', q.carryAllAnswers().length, 0)

const aiAfter = db.select({ n: sql<number>`count(*)` }).from(aiCalls).get().n
expect('no Claude calls', aiAfter - aiBefore, 0)
process.exit(failed ? 1 : 0)

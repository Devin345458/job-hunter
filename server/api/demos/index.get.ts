import { desc, ne } from 'drizzle-orm'
import { demoProjects } from '~~/server/db/schema'
import { toDemoDetail } from '~~/server/utils/demo/store'

// GET /api/demos: every demo project except discarded ones, newest first.
// ?all=1 includes discarded.
export default defineEventHandler((event) => {
  const all = getQuery(event).all === '1'
  const db = useDb()
  const rows = all
    ? db.select().from(demoProjects).orderBy(desc(demoProjects.id)).all()
    : db.select().from(demoProjects).where(ne(demoProjects.status, 'discarded')).orderBy(desc(demoProjects.id)).all()
  return { demos: rows.map(d => ({ ...toDemoDetail(d), buildLog: null, gap: null })) }
})

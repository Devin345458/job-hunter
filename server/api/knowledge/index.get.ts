// GET /api/knowledge?category=skill
// Deduped entries. negative marks a No answer ("Does not know Go"), which is never claimed.
export default defineEventHandler((event) => {
  const query = getQuery(event)
  const category = typeof query.category === 'string' && query.category ? query.category : undefined
  return loadKnowledge(category).map(e => ({ ...e, negative: isNegativeKnowledge(e.value) }))
})

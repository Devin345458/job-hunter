// GET /api/learning/moves?limit=50: recent score changes from score_history, newest first.
export default defineEventHandler((event) => {
  const limit = Number(getQuery(event).limit)
  return { moves: recentScoreMoves(Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50) }
})

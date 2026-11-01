// GET /api/learning/overview: decision counts, every rule with evidence, search adjustments, last learn:daily run.
export default defineEventHandler(() => learningOverview())

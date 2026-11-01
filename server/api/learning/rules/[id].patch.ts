// PATCH /api/learning/rules/:id { active: boolean }
// Devin's switch. The open jobs the rule touches are rescored right away.
export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id) || id <= 0) throw createError({ statusCode: 400, statusMessage: 'Invalid rule ID' })
  const body = await readBody<{ active?: unknown }>(event)
  if (typeof body?.active !== 'boolean') throw createError({ statusCode: 400, statusMessage: 'active must be true or false' })
  const { rule, rescored } = await setRuleActive(id, body.active)
  return { rule: listRuleViews().find(r => r.id === rule.id) ?? null, rescored }
})

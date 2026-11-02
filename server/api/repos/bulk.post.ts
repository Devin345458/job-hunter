import { setReposIncludedBulk } from '~~/server/utils/repos/settings'

// POST /api/repos/bulk { included: true, owner? }  switches on the repos holding his commits (by
//   the last "Find repos with my commits") that are off: one owner's, or every owner's. Forks and
//   repos without his commits stay off.
// POST /api/repos/bulk { included: false, owner }  switches off every repo of one owner and
//   forgets what was indexed from each.
export default defineEventHandler(async (event) => {
  const body = await readBody<{ owner?: unknown; included?: unknown }>(event)
  if (typeof body?.included !== 'boolean') throw createError({ statusCode: 400, statusMessage: 'included must be true or false' })
  const owner = typeof body?.owner === 'string' ? body.owner.trim() : null
  if (owner !== null && !/^[\w.-]+$/.test(owner)) throw createError({ statusCode: 400, statusMessage: 'owner must be a GitHub login' })
  return setReposIncludedBulk({ owner, included: body.included })
})

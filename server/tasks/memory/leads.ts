// Looks up leads in Devin's past Claude sessions for pending questions (free-text, skill, and
// experience questions) and stores up to three on each question row. Runs in the daily chain
// after learn:daily, so it sees the questions learning just asked. Best effort: with memory off
// or the laptop unreachable it records a plain note and the chain carries on.
export default defineTask({
  meta: {
    name: 'memory:leads',
    description: 'Look up leads in your past Claude sessions for pending questions',
  },
  async run({ payload }) {
    const force = (payload as Record<string, unknown> | undefined)?.force === true
    const outcome = await withRun('memory:leads', triggerOf(payload), log => refreshMemoryLeads(log, { force }))
    return { result: outcome }
  },
})

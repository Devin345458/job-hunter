import { runDemoBuilds } from '~~/server/utils/demo/build'

// Builds demo projects for applications in proposed or needs_input whose gap analysis
// recommends one. Refreshes a gap analysis first when a question it asked has been
// answered. At most NUXT_DEMO_MAX_PER_RUN builds per run (payload.max overrides).
// Payload: { applicationId?: number, max?: number, retryFailed?: boolean }
export default defineTask({
  meta: {
    name: 'demos:build',
    description: 'Build demo projects that close requirement gaps',
  },
  async run({ payload }) {
    const p = (payload ?? {}) as Record<string, unknown>
    const outcome = await withRun('demos:build', triggerOf(payload), log => runDemoBuilds({
      applicationId: p.applicationId != null ? Number(p.applicationId) : undefined,
      max: p.max != null ? Number(p.max) : undefined,
      retryFailed: p.retryFailed === true,
    }, log))
    return { result: outcome }
  },
})

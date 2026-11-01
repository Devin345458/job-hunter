import type { GapAnalysis } from '#shared/types/pipeline'

// Owned by the demo-projects unit. Application prep calls this once per application and
// stores the result in applications.gap_analysis_json.
export async function analyzeGaps(applicationId: number): Promise<GapAnalysis> {
  void applicationId
  return { items: [], demoRecommended: false, summary: 'Gap analysis is not built yet.', analyzedAt: new Date().toISOString() }
}

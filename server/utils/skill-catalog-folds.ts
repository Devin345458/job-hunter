import type { SkillFoldPlan } from './skill-catalog'

// The LLM skills the ask-time distill made after the approved catalog applied, each a rewording of
// "Using AI in unsupervised processes" (#153). Applied once by applySkillFoldsOnce() in learn:daily,
// only once approved is true. List what a plan would do on a snapshot copy with
// scripts/eval/llm-skill-repair.ts; it also names distill-made AI skills this list leaves out.
//
// The first three are on the 2026-11-05 snapshot. The last four are the production skill names in
// the 2026-11-06 report, not on that snapshot: a slug that is not in the catalog is skipped, and the
// answered, blocking, and never-merge checks run at apply time for every fold.
// Left out on purpose (Devin's call): "OpenAI or Anthropic APIs" (#456; the catalog keeps the
// vendor skill "Anthropic Claude" apart), "Prompt engineering or model fine-tuning" (#462),
// "AI infrastructure tools" (#425, vector databases and model serving).
export const APPROVED_LLM_SKILL_FOLDS: SkillFoldPlan = {
  name: 'LLM skills into Using AI in unsupervised processes (2026-11-06)',
  approved: false,
  folds: [
    { from: 'llm-api-and-agentic-workflow-building', to: 'using-ai-in-unsupervised-processes' },
    { from: 'ai-llm-applications', to: 'using-ai-in-unsupervised-processes' },
    { from: 'llm-platforms-and-model-apis', to: 'using-ai-in-unsupervised-processes' },
    { from: 'ai-tools-and-llm-apis', to: 'using-ai-in-unsupervised-processes' },
    { from: 'llm-or-ai-agent-hands-on-work', to: 'using-ai-in-unsupervised-processes' },
    { from: 'llm-api-use', to: 'using-ai-in-unsupervised-processes' },
    { from: 'agent-orchestration-and-tool-calling-systems', to: 'using-ai-in-unsupervised-processes' },
  ],
}

// Contract between the learning unit's server code and the /learning and /questions pages.
// Owned by the learning unit. Pipeline-wide shapes stay in shared/types/pipeline.ts.

import type { PipelineRunView, ScoreComponent } from './pipeline'
import type { RepoSuggestionView } from './repos'

export type RuleKind =
  | 'keyword'
  | 'title'
  | 'company'
  | 'industry'
  | 'remote_type'
  | 'location'
  | 'tech'
  | 'comp_floor'
  | 'seniority'

export type RuleEffect = 'score' | 'exclude_search' | 'boost_search'

export interface LearnedRuleView {
  id: number
  kind: RuleKind
  pattern: string
  effect: RuleEffect
  /** Score points the rule adds to a matching job. Negative lowers the score. Zero for search rules. */
  weight: number
  evidenceCount: number
  reasonCode: string | null
  /** Plain label for the reason, e.g. "Not remote" or "Approved". */
  reasonLabel: string
  /** One plain sentence: what Devin did and what the rule now does. */
  explanation: string | null
  active: boolean
  /** Learned from sandbox test decisions. Applies to sandbox jobs only and never to search. */
  isSandbox: boolean
  updatedAt: string
  /** Open jobs this rule matches right now (score rules only). */
  matchingOpenJobs: number
}

export interface SearchAdjustments {
  /** Lowercased. Compare case-insensitively against title, tags, and description. */
  excludedKeywords: string[]
  /** Normalized with ruleCompanyKey() in server/utils/learned-score.ts. */
  excludedCompanies: string[]
  /** Lowercased keywords to add to search queries. */
  boostKeywords: string[]
}

export interface DecisionCounts {
  approvals: number
  rejections: number
  /** Decisions made on sandbox jobs (included in the counts above). */
  sandbox: number
  byReason: Array<{ code: string; label: string; count: number }>
}

export interface LearningOverview {
  decisions: DecisionCounts
  rules: LearnedRuleView[]
  search: SearchAdjustments
  lastRun: PipelineRunView | null
}

export interface ScoreMoveView {
  id: number
  jobId: number
  jobTitle: string
  company: string
  isSandbox: boolean
  /** Score from the previous score_history row for this job, null when this is the first one. */
  oldScore: number | null
  newScore: number
  learnedAdjustment: number | null
  reason: string
  computedAt: string
  /** Learned components from the stored breakdown, so the page can say which rules moved it. */
  components: ScoreComponent[]
}

/** One row on the /questions page. Raw question columns plus what the page needs to render it. */
export interface QuestionListItem {
  id: number
  question: string
  context: string | null
  category: string | null
  kind: string | null
  subject: string | null
  answerType: 'yes_no' | 'text' | 'number' | 'choice' | null
  choices: string[] | null
  knowledgeKey: string | null
  blocking: boolean
  status: string
  answer: string | null
  /**
   * Devin's example for an answered Yes or Some experience question ("Where did you do it?"), in his own
   * words, read back from the question's knowledge entry. Null when he has not given one.
   */
  example: string | null
  /** A yes or no question about a skill or past work: a Yes or Some experience answer asks for an example. */
  takesExample: boolean
  askedAt: string
  answeredAt: string | null
  applicationId: number | null
  jobId: number | null
  job: { id: number; title: string; company: string } | null
  /** needs_input or proposed applications whose answers wait on this question. */
  waitingApplicationIds: number[]
  /** The same applications with their company and job title, so one shared question can name every employer waiting on it. */
  waitingApplications?: Array<{ id: number; company: string; title: string }>
  /** True for rows from the original tailoring flow (no kind, no answer type). */
  legacy: boolean
  /** Pending knows or has_done question with evidence from Devin's own GitHub commits. Null when there is none. */
  repoSuggestion?: RepoSuggestionView | null
}

export interface AnswerOutcome {
  question: QuestionListItem
  /** Knowledge base entry the answer was written to. Null for a skip. */
  knowledge: { category: string; key: string; value: string } | null
  refreshedApplicationIds: number[]
  /** True when applications were waiting but refreshApplicationAnswers() is not on this build. */
  refreshUnavailable: boolean
  rescored: number
}

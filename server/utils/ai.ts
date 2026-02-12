import Anthropic from '@anthropic-ai/sdk'
import { MODEL } from '#server/utils/model'

let _client: Anthropic | null = null

export function useAI() {
  if (_client) return _client

  const config = useRuntimeConfig()
  _client = new Anthropic({
    apiKey: config.anthropicApiKey,
  })

  return _client
}

export interface MatchResult {
  score: number
  reasoning: string
  missingSkills: string[]
  keywordOverlap: string[]
  recommendation: 'strong_match' | 'good_match' | 'partial_match' | 'weak_match'
}

export interface TailoredResume {
  summary: string
  experience: Array<{
    company: string
    title: string
    period: string
    bullets: string[]
  }>
  skills: Record<string, string[]>
  education: Array<{
    institution: string
    degree: string
    year: string
  }>
  tailoringNotes: string
  generatedQuestions: Array<{
    question: string
    context: string
    category: string
  }>
}

const matchResultTool: Anthropic.Tool = {
  name: 'submit_match_result',
  description: 'Submit the job match scoring result',
  input_schema: {
    type: 'object' as const,
    properties: {
      score: { type: 'number', description: 'Match score from 0-100' },
      reasoning: { type: 'string', description: '2-3 sentence explanation of the score' },
      missingSkills: { type: 'array', items: { type: 'string' }, description: 'Skills the job needs that the candidate lacks' },
      keywordOverlap: { type: 'array', items: { type: 'string' }, description: 'Matching keywords between JD and resume' },
      recommendation: { type: 'string', enum: ['strong_match', 'good_match', 'partial_match', 'weak_match'] },
    },
    required: ['score', 'reasoning', 'missingSkills', 'keywordOverlap', 'recommendation'],
  },
}

const tailorResumeTool: Anthropic.Tool = {
  name: 'submit_tailored_resume',
  description: 'Submit the tailored resume data',
  input_schema: {
    type: 'object' as const,
    properties: {
      summary: { type: 'string', description: 'Tailored professional summary, 2-3 sentences' },
      experience: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            company: { type: 'string' },
            title: { type: 'string' },
            period: { type: 'string' },
            bullets: { type: 'array', items: { type: 'string' } },
          },
          required: ['company', 'title', 'period', 'bullets'],
        },
      },
      skills: {
        type: 'object',
        additionalProperties: { type: 'array', items: { type: 'string' } },
        description: 'Skills grouped by category',
      },
      education: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            institution: { type: 'string' },
            degree: { type: 'string' },
            year: { type: 'string' },
          },
          required: ['institution', 'degree', 'year'],
        },
      },
      tailoringNotes: { type: 'string', description: 'What was changed and why' },
      generatedQuestions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            context: { type: 'string' },
            category: { type: 'string', enum: ['technical', 'behavioral', 'preference'] },
          },
          required: ['question', 'context', 'category'],
        },
      },
    },
    required: ['summary', 'experience', 'skills', 'education', 'tailoringNotes', 'generatedQuestions'],
  },
}

export async function scoreJobMatch(
  jobDescription: string,
  knowledgeBase: Record<string, string>,
): Promise<MatchResult> {
  const ai = useAI()

  const message = await ai.messages.create({
    model: MODEL,
    max_tokens: 1024,
    tools: [matchResultTool],
    tool_choice: { type: 'tool', name: 'submit_match_result' },
    messages: [{
      role: 'user',
      content: `You are a job matching assistant. Score how well this candidate matches the job description.

## Candidate Profile
${Object.entries(knowledgeBase).map(([k, v]) => `**${k}:** ${v}`).join('\n')}

## Job Description
${jobDescription}

Focus on: role level match, tech stack overlap, experience relevance. Be realistic - don't inflate scores.`,
    }],
  })

  const toolUse = message.content.find(block => block.type === 'tool_use')
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('AI did not return structured match result')
  }

  return toolUse.input as MatchResult
}

export async function tailorResume(
  jobDescription: string,
  knowledgeBase: Record<string, string>,
): Promise<TailoredResume> {
  const ai = useAI()

  const message = await ai.messages.create({
    model: MODEL,
    max_tokens: 4096,
    tools: [tailorResumeTool],
    tool_choice: { type: 'tool', name: 'submit_tailored_resume' },
    messages: [{
      role: 'user',
      content: `You are a resume tailoring expert. Restructure and reframe the candidate's experience for this specific job.

## RULES
- NEVER fabricate experience. Only reframe and reorder existing experience.
- Prioritize relevant accomplishments. Match JD keywords naturally.
- Adjust the professional summary to target this role.
- Reorder experience bullets to highlight most relevant first.
- Add relevant keywords from the JD where they genuinely apply.

## Candidate Knowledge Base
${Object.entries(knowledgeBase).map(([k, v]) => `**${k}:** ${v}`).join('\n')}

## Target Job Description
${jobDescription}`,
    }],
  })

  const toolUse = message.content.find(block => block.type === 'tool_use')
  if (!toolUse || toolUse.type !== 'tool_use') {
    throw new Error('AI did not return structured resume result')
  }

  return toolUse.input as TailoredResume
}

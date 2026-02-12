import Anthropic from '@anthropic-ai/sdk'

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

export async function scoreJobMatch(
  jobDescription: string,
  knowledgeBase: Record<string, string>,
): Promise<MatchResult> {
  const ai = useAI()

  const message = await ai.messages.create({
    model: 'claude-sonnet-4-5-20250514',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `You are a job matching assistant. Score how well this candidate matches the job description.

## Candidate Profile
${Object.entries(knowledgeBase).map(([k, v]) => `**${k}:** ${v}`).join('\n')}

## Job Description
${jobDescription}

Respond in JSON format:
{
  "score": <0-100>,
  "reasoning": "<2-3 sentence explanation>",
  "missingSkills": ["<skills the job needs that candidate lacks>"],
  "keywordOverlap": ["<matching keywords between JD and resume>"],
  "recommendation": "<strong_match|good_match|partial_match|weak_match>"
}

Focus on: role level match, tech stack overlap, experience relevance. Be realistic - don't inflate scores.`,
    }],
  })

  const text = message.content[0].type === 'text' ? message.content[0].text : ''
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Failed to parse AI match response')

  return JSON.parse(jsonMatch[0]) as MatchResult
}

export async function tailorResume(
  jobDescription: string,
  knowledgeBase: Record<string, string>,
): Promise<TailoredResume> {
  const ai = useAI()

  const message = await ai.messages.create({
    model: 'claude-sonnet-4-5-20250514',
    max_tokens: 4096,
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
${jobDescription}

Respond in JSON format:
{
  "summary": "<tailored professional summary, 2-3 sentences>",
  "experience": [
    {
      "company": "<company name>",
      "title": "<job title>",
      "period": "<date range>",
      "bullets": ["<achievement bullet points, reordered for relevance>"]
    }
  ],
  "skills": {
    "<category>": ["<skill1>", "<skill2>"]
  },
  "education": [
    {
      "institution": "<school>",
      "degree": "<degree>",
      "year": "<year>"
    }
  ],
  "tailoringNotes": "<what was changed and why>",
  "generatedQuestions": [
    {
      "question": "<specific question about a gap in the knowledge base>",
      "context": "<why this question matters for this application>",
      "category": "<technical|behavioral|preference>"
    }
  ]
}`,
    }],
  })

  const text = message.content[0].type === 'text' ? message.content[0].text : ''
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Failed to parse AI tailoring response')

  return JSON.parse(jsonMatch[0]) as TailoredResume
}

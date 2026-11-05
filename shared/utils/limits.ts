// Character limits the app and the server share.

/**
 * Longest example ("Where did you do it?") a Yes or Some experience answer takes. The knowledge
 * base keeps all of it; a form field with its own limit gets a shortened copy
 * (server/utils/apply/fit.ts), so a long example never reaches an employer cut off.
 */
export const EXAMPLE_MAX_CHARS = 5000

/** Above this many characters most application forms shorten an example, so the box warns (it never blocks). */
export const EXAMPLE_LONG_CHARS = 2500

/**
 * How deep a drafted answer to a skill or experience question goes (Devin, 2026-11-05): core, a
 * core catalog skill's full answer, in the shape of the one he wrote himself; short, every other
 * skill, 2 or 3 conversational sentences. answerDepthFor() in server/utils/skill-catalog.ts decides.
 */
export type AnswerDepth = 'core' | 'short'

/**
 * Length by depth. Sentences count after a level standing alone ("Yes."); a form field's own limit
 * wins over maxChars when smaller.
 * - short: 2 or 3 sentences, about 250 to 450 characters, never over 600.
 * - core: 3 or 4 short paragraphs, about 900 to 1,200 characters, never over 1,300.
 */
export const ANSWER_DEPTH_LIMITS: Record<AnswerDepth, { minSentences: number; sentences: number; paragraphs: number; minChars: number; targetChars: number; maxChars: number }> = {
  short: { minSentences: 2, sentences: 3, paragraphs: 1, minChars: 250, targetChars: 450, maxChars: 600 },
  core: { minSentences: 5, sentences: 10, paragraphs: 4, minChars: 900, targetChars: 1200, maxChars: 1300 },
}

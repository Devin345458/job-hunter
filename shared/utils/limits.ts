// Character limits the app and the server share.

/**
 * Longest example ("Where did you do it?") a Yes or Some experience answer takes. The knowledge
 * base keeps all of it; a form field with its own limit gets a shortened copy
 * (server/utils/apply/fit.ts), so a long example never reaches an employer cut off.
 */
export const EXAMPLE_MAX_CHARS = 5000

/** Above this many characters most application forms shorten an example, so the box warns (it never blocks). */
export const EXAMPLE_LONG_CHARS = 2500

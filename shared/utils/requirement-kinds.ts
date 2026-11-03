// Posting requirements that are not technical skills. Shared by the skill chips (skill-sets.ts),
// the gap reader (server/utils/demo/gaps.ts), and the question cleanup (server/utils/questions.ts),
// so a work authorization line is never a red Missing chip on one screen and a gap question on another.

/**
 * Requirements that are facts in the profile, never skill or experience gaps: work authorization,
 * sponsorship, citizenship, residency, relocation, clearance, location, time zone, and degrees.
 * "Live and work permanently in the U.S." and "Based in the US or Canada" are location facts.
 * Leading a team "across multiple time zones" and "AWS-based infrastructure" are not.
 */
export const NOT_A_GAP = new RegExp([
  String.raw`\bwork(?:ing)? authori[sz]ation`,
  String.raw`\bauthori[sz]ed to work`,
  String.raw`\beligib(?:le|ility) to work`,
  String.raw`\blegally (?:able|eligible|permitted) to work`,
  String.raw`\bright to work`,
  String.raw`\bwork permit`,
  String.raw`\bvisa (?:sponsorship|status|support|holders?)\b`,
  String.raw`\bwork visas?\b`,
  String.raw`\bh-?1b\b`,
  String.raw`\bsponsorship\b`,
  String.raw`\bcitizen(?:ship|s)?\b`,
  String.raw`\bgreen card`,
  String.raw`\bpermanent(?:ly)? resid\w*`,
  String.raw`(?<!\bdata )\bresidency\b`,
  String.raw`\bresid(?:e|es|ing) in\b`,
  String.raw`\brelocat\w*`,
  String.raw`\bclearance\b`,
  String.raw`(?<!\bacross\s(?:[\w-]+\s){0,3})\btime ?zones?\b`,
  String.raw`\blive and work\b`,
  String.raw`\bwork permanently\b`,
  String.raw`\blocal to\b`,
  String.raw`(?<![\w-])(?:based|located|living) (?:in|within|out of)\b`,
  String.raw`\blocation\b(?!-|\s+(?:data|services?|tracking|apis?|sharing|intelligence)\b)`,
  String.raw`\bin[- ]office\b`,
  String.raw`\bon[- ]?site\b`,
  String.raw`\bcommut\w*`,
  String.raw`\b(?:US|U\.S\.|EST|ET|CST|CT|MST|PST|PT|Pacific|Eastern|Central|Mountain|business) (?:time )?hours\b`,
  // A degree line names the degree first: "Bachelor's degree ...", "BS or MS in ...", "Degree in ...".
  // "9+ years ... (or 7+ with an advanced degree)" is a years requirement and "a high degree of autonomy" is not a degree.
  String.raw`^\W*(?:an? )?(?:bachelor|master|ph\.?\s?d|doctorate|b\.?s\.?\b|m\.?s\.?\b|b\.?a\.?\b|graduate|undergraduate|associate'?s? degree)`,
  String.raw`^\W*(?:an? )?(?:[\w-]+ ){0,3}degree\b(?! of)`,
].join('|'), 'i')

/**
 * Soft skills and traits: communication, collaboration, attention to detail, ownership, a bias to
 * action, eagerness to learn, and similar. No code project or resume line closes them, so the card
 * lists them on one neutral line instead of as red Missing chips. Bare "team", "leadership",
 * "mentor", and "fast-paced" are left out on purpose: "Leading multiple engineering workstreams" and
 * "Leading and managing SRE teams in a fast-paced environment" are real experience. Secure
 * communication protocols are a technical skill.
 */
export const SOFT_SKILL = new RegExp([
  String.raw`(?<!\b(?:secure|real-time|network|discord|serial|interprocess|inter-process|machine|device)\s)\bcommunicat(?:e|es|ing|ion|ions|or|ors|ive)?\b(?!\s+(?:protocols?|platforms?|systems?|apis?|stacks?|infrastructure|services?|tools?|channels?|layers?|networks?)\b)`,
  String.raw`\bcollaborat\w*`,
  String.raw`\binterpersonal\b`,
  String.raw`\battention to detail\b`,
  String.raw`\bdetail[- ]oriented\b`,
  String.raw`\bbias (?:to|toward|towards|for) action\b`,
  String.raw`\beager(?:ness)? to learn\b`,
  String.raw`\b(?:quick|fast) learner\b`,
  String.raw`\bcurious\b`,
  String.raw`\bcuriosity\b`,
  String.raw`\bself[- ](?:starter|motivated|directed|driven)\b`,
  String.raw`\bproactive\b`,
  String.raw`\b(?:sense of|strong|take|takes|taking|high) ownership\b`,
  String.raw`\bownership (?:mindset|mentality)\b`,
  String.raw`\badaptab\w*`,
  String.raw`\bgrowth mindset\b`,
  String.raw`\bteam player\b`,
  String.raw`\bempath\w*`,
  String.raw`\bhumble\b`,
  String.raw`\bhumility\b`,
  String.raw`\bwork ethic\b`,
  String.raw`\b(?:comfortable|comfort) (?:with|operating in) ambiguity\b`,
  String.raw`\bthrives? (?:in|with)\b`,
  String.raw`\bpositive attitude\b`,
  String.raw`\b(?:written|verbal|oral) (?:and|&) (?:written|verbal|oral)\b`,
].join('|'), 'i')

/** A soft term this far into a requirement is an add-on to a technical one ("Hands-on technical leadership ..., with excellent communication skills"). */
const SOFT_HEAD_CHARS = 40

/** Work authorization, location, time zone, and degree lines: profile facts, never skill chips. */
export function isProfileFact(text: string | null | undefined): boolean {
  return !!text && NOT_A_GAP.test(text.trim())
}

/** A soft skill or trait ("Strong communication skills", "Bias toward action"), not a technical one. */
export function isSoftSkill(text: string | null | undefined): boolean {
  if (!text || isProfileFact(text)) return false
  const m = SOFT_SKILL.exec(text.trim())
  return !!m && m.index < SOFT_HEAD_CHARS
}

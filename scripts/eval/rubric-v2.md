# Judging rubric for the model evaluation, round two

Round two uses the round one codes unchanged. The changes below settle the questions round one
judges raised in cannotJudge, and they were fixed before any round two verdict was written:
- C3: joining the minimum of one listed range to the maximum of another is an error.
- Every error names its field, and an error that repeats a wrong status from the fixed input is
  marked inherited.
- G codes are judged against the knowledge base the gap step read (printed in the packet).
- M2 allows a mustHaves value that moves away from the expected number because it corrects an
  input status the knowledge base contradicts.
- Must or nice: an item in a requirements, qualifications, "about you", or "what we're looking
  for" list is a must unless the posting marks it preferred, nice to have, bonus, or plus. A duty
  with no such wording is a must. A technology named only in a list of the team's stack is a nice.
- Years: profile/Years of Experience says 6+. Judge years requirements against that entry, as
  round one did, even though the dated roles add up to more.
- A benefit that appears only in notes counts as named, not missed.

Fixed before any verdict was written. Judges see four outputs per job under the letters A to D and
never learn which model wrote which. Judge every output against the posting text and the knowledge
base in the packet, never against another output. When outputs disagree, read the posting and decide
who is right.

Count each distinct mistake once. Cite the posting sentence or the knowledge base line that proves it.
"Material" means Devin would see something false or miss something that changes a decision.

## Enrich: compensation

Errors (each counts):
- C1 figure: a base, bonus, equity, or benefit figure that the posting does not state, or states differently.
- C2 unit: wrong pay period, or wrong currency (a CAD or EUR figure treated as USD, or a non-USD range chosen when a USD range exists).
- C3 range: several US ranges (by zone, tier, city, or level) are listed. Using any one listed US range, exactly as listed, passes when the other ranges are mentioned in notes. Fails when the chosen range is not US, when the other ranges are not mentioned, or when the stored range joins the minimum of one listed range to the maximum of another.
- C4 category: OTE, sign-on, profit share stated as a dollar figure, a company metric ($ raised, ARR, payouts to contractors), or a benefit premium table read as pay. A recurring annual bonus with no figure listed as a bonus is correct.
- C5 invented: a benefit, bonus, or equity item the posting never names.
- C6 base missed: the posting states a base range for US candidates and the stored result has no base (whether the model missed it or the app dropped it because the quote was not verbatim). Also: base pay stored for a posting that states none.

Not errors, recorded separately as completeness:
- benefits the posting names that the output leaves out (count them).
- a quote the app dropped for a benefit (count them; the benefit disappears from what Devin sees).

## Enrich: requirements

Statuses mean: have (an entry directly shows it), partial (an entry shows something close), lack (an entry contradicts it), unknown (the knowledge base does not mention it).

Errors (each requirement row counts once, judged on the stored status, after the app's evidence check):
- R1 false credit: have or partial when no knowledge base entry supports it. The worst error: it tells Devin he has something he may not.
- R2 false lack: lack when no entry contradicts it.
- R3 missed credit: unknown when an entry directly shows it (for example Vue.js listed as unknown).
- R4 wrong level: have when the entry only shows something close (should be partial), or partial when the entry shows exactly it (should be have). Years: "6+" meets "5+ years" (have); "6+" against "8+ years" is lack or partial, not have.
- R5 not in posting: a requirement the posting does not state, or must or nice flipped against what the posting says (the posting's "nice to have", "preferred", "bonus", "plus" are nice).

Completeness, recorded separately: must-have requirements the posting states that the list leaves out, when the list has room (under 20 rows).

## Match

Errors:
- M1 false claim: the reasoning, matched, or missing list says the candidate has something the knowledge base does not show, or lacks something it shows.
- M2 part off rubric: a part clearly outside its anchors. mustHaves: compare with the expected value from the fixed input statuses printed in the packet; more than 8 points away is an error unless the difference comes from correcting an input status the knowledge base contradicts (for example a years requirement the input marks have against a 6+ profile). stack: 25 same primary stack, 15 related, 5 learnable, 0 unrelated discipline. seniority: 20 right level, 10 one step off, 0 far off or not engineering. domain: 10 same, 5 nearby, 0 unrelated or highly specialized.
- M3 wrong job: the reasoning misstates the role, level, or stack.
- M4 style: refers to the candidate as he, she, or they, or uses an em or en dash.

Also give the reasoning a wording score from 1 to 5 for Devin reading it on the review card: 5 is plain, specific, names the real strengths and gaps in two or three sentences; 1 is vague, wrong, or hard to parse.

## Gap analysis

Judge every G code against the knowledge base the GAP step read. It includes profile entries
(GitHub username) and preference entries that the enrich and match steps never see.

Step 1 (candidates) errors:
- G1 omitted: a requirement in the fixed input whose status is not have, and that is a concrete technical item (language, framework, tool, platform, technical practice), missing from the candidates.
- G2 included wrongly: a candidate whose input status is have, or that the knowledge base names directly, or a soft skill, years, education, work authorization, or location.
- G3 showable flag wrong: codeShowable true for something a small code project cannot show (leading people, production scale, on-call, domain experience), or false for a language, framework, or tool.
- G4 question: not answerable yes or no in one tap, or so vague the answer would not settle the gap.

Step 3 (decisions) and the final result errors:
- G5 bad decision: a demo that breaks the prompt's rules (needs a database server, broker, or cloud service; not written in the gap's subject; more than about four hours; not credible for a senior web developer to own), a reframe that names an entry that does not cover the gap, or a skip that ignores a must-have demo the rules clearly allow.
- G6 fabrication: a rationale or demo idea that states a fact about Devin the knowledge base does not state.
- G7 style: refers to Devin as he, she, or they, or uses an em or en dash, in text Devin reads.

Give the gap result a wording score from 1 to 5 for the rationales and questions Devin reads.

## Fields and inherited errors

Every error names its field: the requirement text for a requirement row, "base", "bonus",
"equity", or the benefit name for compensation, the part name ("mustHaves", "stack",
"seniority", "domain") or a short claim for match, and the candidate subject or decision for
gaps. One field gets at most one error per output: pick the most serious code.

Set "inherited": true on a MATCH or GAP error when the output repeats a status from the fixed
input requirements that is itself wrong (for example matched "7+ years" because the input says
have). It still counts as an error; the flag only says where it came from.

## Verdict format

Each step has its own letters in the packet: enrich A B D E F H, match I J K L N O, gaps
P Q S T U V. One JSON file per job, `<outDir>/verdicts/job-<id>.json`:

```json
{
  "jobId": 0,
  "enrich": {
    "A": { "comp": [{ "code": "C1", "field": "base", "detail": "...", "evidence": "posting sentence" }], "reqs": [{ "code": "R1", "field": "Go", "row": 3, "detail": "...", "evidence": "..." }], "requirementRows": 14, "compItems": 9, "benefitsMissed": 0, "benefitsDroppedByApp": 0, "mustHavesMissed": 0 }
  },
  "match": { "I": { "errors": [{ "code": "M1", "field": "7+ years", "inherited": true, "detail": "..." }], "wording": 4 } },
  "gaps": { "P": { "errors": [{ "code": "G2", "field": "GitHub", "inherited": false, "detail": "..." }], "candidates": 7, "wording": 4 } },
  "disagreements": [{ "step": "enrich", "topic": "...", "who_is_right": "A and E", "why": "posting sentence" }],
  "cannotJudge": ["anything you could not decide, and why"]
}
```

requirementRows is the number of requirement rows in that output's table. compItems counts base,
bonus, and equity when present, plus each benefit in the model's extraction. candidates is the
number of step 1 gap candidates.

# Judging rubric for the model evaluation

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
- C3 range: several US ranges (by zone, tier, city, or level) are listed. Using any listed US range passes when the other ranges are mentioned in notes. Fails when the chosen range is not US, or the other ranges are not mentioned.
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
- M2 part off rubric: a part clearly outside its anchors. mustHaves: compare with the expected value from the fixed input statuses printed in the packet; more than 8 points away without a reason the input supports is an error. stack: 25 same primary stack, 15 related, 5 learnable, 0 unrelated discipline. seniority: 20 right level, 10 one step off, 0 far off or not engineering. domain: 10 same, 5 nearby, 0 unrelated or highly specialized.
- M3 wrong job: the reasoning misstates the role, level, or stack.
- M4 style: refers to the candidate as he, she, or they, or uses an em or en dash.

Also give the reasoning a wording score from 1 to 5 for Devin reading it on the review card: 5 is plain, specific, names the real strengths and gaps in two or three sentences; 1 is vague, wrong, or hard to parse.

## Gap analysis

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

## Verdict format

One JSON file per job, `data/eval/judge/verdicts/job-<id>.json`:

```json
{
  "jobId": 0,
  "A": {
    "enrich": { "comp": [{ "code": "C1", "detail": "...", "evidence": "posting sentence" }], "reqs": [{ "code": "R1", "row": 3, "requirement": "...", "detail": "...", "evidence": "..." }], "benefitsMissed": 0, "benefitsDroppedByApp": 0, "mustHavesMissed": 0 },
    "match": { "errors": [{ "code": "M2", "detail": "..." }], "wording": 4 },
    "gaps": { "errors": [{ "code": "G1", "detail": "..." }], "wording": 4 }
  },
  "B": {}, "C": {}, "D": {},
  "disagreements": [{ "topic": "...", "who_is_right": "A and C", "why": "posting sentence" }],
  "cannotJudge": ["anything you could not decide, and why"]
}
```

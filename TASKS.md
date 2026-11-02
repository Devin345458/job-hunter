# TASKS

Checklist for the job-hunter /goal run that started 2026-11-01. Tick an item only when it is verified on the deployed app at http://job-hunter.devinsmini.com, unless the item says otherwise. Add new findings at the bottom of the section they belong to.

## What the deployed app exposed before this run (checked 2026-11-01)

- [x] Every `/api/*` route answered without a login, reads and writes. `/api/knowledge` returned name, email, and phone.
- [x] `POST /api/jobs/search` and `POST /api/jobs/match` could be triggered by anyone and spend the Anthropic and RapidAPI keys.
- [x] The running container was built from commit 37481e5 (February). Pushes since then never deployed.
- [x] `jobs:search` and `jobs:match` fire daily in the container at 06:00 and 07:00 UTC. `jobs:match` failed every day: the old build calls the retired model id `claude-sonnet-4-5-20250514`, so 0 of 50 jobs were scored.
- [x] JSearch returns 403 (the RapidAPI key has no active subscription). Adzuna returns 400 (malformed query). Only Remotive produced jobs.
- [x] Every knowledge base row exists three times (the seed ran three times on prod).
- [x] The GitHub repo `Devin345458/job-hunter` is public, and `server/db/seed.ts` has held the phone and email since the initial commit.
- [x] `.dockerignore` excludes `*.db` at the root only, so the February laptop database was baked into the image at `/app/data/job-hunter.db`. The live database is the `/data` volume.

## Unit 1: land the Vuetify style change

- [x] Peer QA walk (session job-hunter-9b) verdict received: icons and fonts fine, two regressions (64px empty band on every desktop page, field corners 8px to 4px).
- [x] Both regressions fixed: app bar and bottom nav bound to `!isDesktop`; settings moved into `components.scss`. Probed on a local production build: desktop main padding 0, drawer at y=0, fields 8px; mobile 64px bar and 56px nav.
- [x] MDI icons render (`.v-icon::before` font-family is Material Design Icons on the production build).
- [x] Stage from the working tree, not the stale index (empty `components.scss`, empty `plugins/vuetify.ts`).
- [x] AGENTS.md corrected (`components.scss`, no MDI middleware claim) and committed.
- [x] `.dockerignore` excludes `data/`.
- [x] Committed on main as a014e13 and deployed (container image `i40g4ock48g0cwwgc4s88okk:a014e13`). Deployed pages probed at 1280 and 390 wide: no band, fields 8px, MDI icons, no horizontal scroll, console clean.

## Unit 2: foundation (auth, data model, AI client, container)

- [x] Single-user login. On prod (86fef3c): `/` and `/jobs` redirect to `/login`, `/api/stats`, `/api/knowledge`, `/api/jobs`, `/api/review/queue` return 401; only `/login`, `/api/health`, and the sandbox are public. http redirects to https.
- [x] Password hash and session secret live in Coolify env (literal, production only). Generated password stored in the macOS keychain item `job-hunter-admin` (account `devin`). Login on prod: right password 200, wrong 401.
- [x] Login rate limit and lockout (5 failures per client per 15 minutes, 20 global per hour).
- [x] One additive migration with the full data model (0001; ALTER ADD and CREATE only). Ran against a copy of the prod DB first; prod DB backed up to `/data/backups/pre-0001-202611010848.db` before deploy.
- [x] Shared TypeScript types (`shared/types/pipeline.ts`) and the review API contract (queue, detail, approve, reject), tested on a prod DB copy: reject needs a reason, approve returns 202 and runs the approval chain, approving a declined application returns 409.
- [x] Anthropic SDK 1.3, structured outputs, usage and cost logged to `ai_calls`. Primary `claude-opus-5-5` with automatic fallback to `claude-haiku-4-5`, because the key returns 429 on every model except Haiku 4.5.
- [x] Daily Claude budget (`NUXT_DAILY_AI_BUDGET_USD`, 10 on prod) enforced before every call.
- [x] Dockerfile runs Playwright Chromium on arm64, has git, sets `TZ=America/Chicago`. Built and run locally on arm64, then on prod: `POST /api/pipeline/browser-check` launches Chromium 156 inside the production container.
- [x] Every scheduled task writes a `pipeline_runs` row. Protected manual trigger `POST /api/pipeline/run`. Daily chain at 06:00 Central plus a 15 minute heartbeat.
- [x] Sandbox employer posting and form at `/sandbox/apply/:token` record submissions (browser-submitted locally: confirmation page, payload and resume file stored).
- [x] Knowledge base reads dedupe the triplicated rows (133 rows read as 45 on prod). No prod rows deleted. Seed script no longer re-seeds.
- [x] Deployed (image `86fef3c`, health endpoint reports the same commit), login works on prod.

## Capability agents (Orca worktrees, dispatched 2026-11-01)

- [x] match: `cap-match` worktree, branch `feature/cap-match`
- [x] apply: `cap-apply`, branch `feature/cap-apply`
- [x] demos: `cap-demos`, branch `feature/cap-demos`
- [x] dashboard: `cap-dashboard`, branch `feature/cap-dashboard`
- [x] learning: `cap-learning`, branch `feature/cap-learning`

## Capability A: match on skills and total compensation

- [x] Adzuna fixed (prod run: 38 listings). JSearch reports its missing RapidAPI subscription cleanly (blocked on you).
- [x] Greenhouse, Lever, and Ashby public boards added for a verified list of remote US employers.
- [x] Enrichment fetches the full posting, resolves the employer form, detects the ATS (prod: 40 enriched, 26 with a real form).
- [x] Salary, bonus, equity, and benefits extracted with exact posting quotes; benefits without a stated dollar figure are not valued.
- [x] Total compensation compared to the floor and target in the knowledge base. Missing floor and health-insurance value become questions.
- [x] Score = 60% skills + 40% compensation + learned adjustment, breakdown stored, shown on the job page and review card.
- [x] Verified on prod with listings pulled today (pass 1: 329 found, 40 enriched, 40 scored).

## Capability B: prepare each application

- [x] Tailored resume (reframe only) with a second evidence-check pass; PDF. Spot-checked seven resume and cover letter claims ("team of 7 developers", "over 1000%", "30%", and others): each traces to a knowledge base experience entry.
- [x] Cover letter with the same evidence check.
- [x] Form engine: Greenhouse, Lever, Ashby, Workable, sandbox, generic fallback. Extracts fields, answers from the knowledge base, fills, screenshots, never submits in the dry run, never attaches files outside the approved submit. Prod: sandbox form 20 fields, 14 filled, screenshot and PDF served.
- [x] Unknown facts become plain questions ("Have you used Go in a real project?"). EEO fields take the decline option.
- [x] Account-required ATS routed to `needs_manual`; submit refuses them.
- [x] Gap analysis per requirement: demo, reframe, ask, or skip. Asks instead of assuming.
- [x] Demo build in the production image: Go payment webhook receiver, 13 files, all tests pass, about $0.65 on Haiku 4.5. Model-chosen commands run as uid 10001, which cannot read the DB, resumes, or the server env (verified on a real Linux volume).
- [x] On approve only: publish demo, add resume card, submit. Verified in the production image against local bare repos (sandbox) and the sandbox form: status `submitted`, reference number 1. Real GitHub publish waits on NUXT_GITHUB_TOKEN (see Blocked).
- [x] Filled but unsubmitted applications on real employer forms from listings pulled today, on prod (pass 1: CompanyCam, Brilliant, 1Password, AppFolio).

## Capability C: review dashboard

- [x] Queue shows job, match reasoning, compensation, resume, cover letter, filled answers with screenshot, and demo project (agent evidence reviewed: desktop two-pane, phone single column).
- [x] One-tap approve and reject. Reject asks for a reason ("Other" needs a note). Only approve submits.
- [ ] Clearable in five minutes a day on a phone.
- [x] None of the banned defaults: cream or off-white backgrounds, italic accent words in headings, numbered section labels, monospace labels, pill buttons. Checked on every page at 1280 and 390 on production (commit 802c1b9) by computed style: buttons and chips 6 to 8px radius (up to 151 buttons on one page), body rgb(15, 19, 24), no italic in headings, no numbered labels, no monospace labels (the check flagged the demo build log, which is meant to be monospace, so it works).

## Capability D: learning

- [x] Plain questions with one-tap answers; answers write the knowledge base (negative answers too) and refresh every waiting application.
- [x] Every approve and reject recorded with the reason and a job feature snapshot.
- [x] Rejection reasons become learned rules (score, exclude from search, boost). Sandbox decisions only make sandbox rules.
- [x] Five rejections for one reason visibly move the next day's scores. Prod proof on sandbox jobs: five Not remote rejections made onsite and hybrid rules of -15; open onsite job 99 to 84, remote job unchanged; score history records the move.

## Verification passes (at least three)

- [ ] Pass 1: deployed dashboard, every element clicked at desktop and mobile width, console and network clean.
  - 2026-11-02, commit 802c1b9, qa-walker: FAILED. 12 major and 22 minor defects; no 4xx or 5xx from the app; one JS error once (`Cannot read properties of null (reading 'trim')` on /applications/14). Being fixed in worktrees `fix-review` (errors shown raw, run status, review cards, questions) and `fix-shell` (jobs pages, navigation, layout). Re-walk after merge.
- [x] Pass 1: pipeline:daily on prod, 2026-11-01 10:16: search, enrich, match, prepare. Four real forms filled and not submitted (CompanyCam and 1Password and AppFolio on Ashby, Brilliant on Lever), screenshots served; no files attached; one demo built.
- [x] Pass 1: answered the two blocking questions and approved the sandbox card in the deployed UI; it reached `submitted` (reference 1) after two fixes (sandbox relabeled by enrichment; sandbox detection now uses the opened URL). Real submits stay off.
- [x] Pass 1: the 15 minute heartbeat fired on schedule in every deployed container (pipeline_runs host = container id from /api/health).
- [ ] Pass 2: same four checks.
  - [x] Scheduler: the daily chain fired on its own schedule at 06:00 Central on 2026-11-02 (pipeline_runs 95, trigger `schedule`), and the heartbeat kept firing every 15 minutes through the night.
  - [x] Login sweep: 47 routes, every protected route 401 without a session.
  - [x] Pipeline on today's listings: Devin's manual pipeline:daily at 15:34 UTC on the new token (run 125): 40 enriched, 47 scored, 0 failed; the five credit-failed applications prepared again, and three real employer forms were filled and not submitted (Spotify and Metabase on Lever, AppFolio on Ashby), each stopped at a captcha and waiting on answers. The last step (demos:build, run 131) was cut off by my deploy at about 15:42; the two credit-failed demos retry on the next run.
  - [x] Sandbox submit: both sandbox applications (11, 12) had found no form fields because their jobs still pointed at the sandbox posting page (enriched before the guard). Fixed in 4a0b7ad. Re-filled on production (20 fields, 16 filled each, no open questions), then approved application 11 in the deployed dashboard at 16:12 UTC: status submitted, sandbox confirmation "Reference number 2", 18 fields and the 37 KB resume PDF stored. Real submits stay off.
  - [ ] Browser click-through at both widths.
- [ ] Pass 3: same four checks.

## Found during the run

- 2026-11-02: Devin switched NUXT_ANTHROPIC_API_KEY to a Max subscription OAuth token (sk-ant-oat01) for this personal project. The app's SDK accepts it; Haiku 4.5 answers, Opus 5.5 returns 429 on this direct-API path, so the app runs on its Haiku fallback. Anthropic's current legal and compliance page assumes "ordinary, individual usage of Claude Code and the Agent SDK" on Pro and Max, and limits its API-key requirement to developers building products for others; my first reading quoted the February 2026 wording, since rewritten. Option for Opus: Max includes $100 a month of API credit for a Console organization linked to the plan.
- 2026-11-02: a 401 from Anthropic (rejected key) was not a run stop; each job and application would have been marked failed. Now it stops the run like running out of credit (bb4932a).
- 2026-11-02: I deployed while Devin's manual pipeline run was in its demos:build step and the restart cut it off. Check /api/pipeline/runs for a running run before every push.
- 2026-11-02: the question step asked the home address four ways (ZIP, street, city and state twice) and asked for initials although the profile has the full name. Fix in worktree `fix-questions`.

- 2026-11-02 QA walk: the floating button on Jobs started a live search in one click with no label or confirmation; the walker clicked it and added one real listing (job 400, Capital One, Staff AI Engineer). That search was not recorded in pipeline_runs. Fix in `fix-shell`.
- 2026-11-02 QA walk: raw Anthropic error JSON and a full server stack trace (with internal paths) were shown in the dashboard; the stack trace caused sideways scroll on phones. Fix in `fix-review`.
- 2026-11-02 QA walk: Jobs listed only the first 20 of 400 jobs with no way to page. Fix in `fix-shell`.
- 2026-11-02 QA walk: a shared blocking question showed the first employer's context on other employers' cards (CompanyCam's required LinkedIn field read "Sandbox Test Co ... optional"). Fix in `fix-review`.

- 2026-11-02: the Anthropic account behind the production key is out of credit. Every Claude call from production fails with "Your credit balance is too low". Runs used to mark each job and application as failed; now a credit error stops the run like the daily budget, applications wait in `preparing` without spending a retry, and the review page shows a red "Claude is out of credit" note.
- Local Claude calls in this repo go through the TeamClaude proxy (`ANTHROPIC_BASE_URL=http://localhost:3456`, Max subscriptions), not the API key. Local "Claude works" results say nothing about the production key; test with `env -u ANTHROPIC_BASE_URL`. The capability agents' local runs went through the proxy too.
- The daily question step pasted requirement text into "Do you know ...?" ("Do you know 2+ years of experience with LangChain?"), asked Python three times, and asked about English. Now it asks about a clean skill name in plain words, skips compounds, generic words, human languages, and skills the knowledge base implies, tidies old questions each run, and adds at most five new ones per day. Production went from 40 pending questions to 37 with five new ones included.

- Enrichment relabeled the sandbox job's ATS and pointed its link at the posting page, so the submit guard treated the sandbox as a real employer and refused (safe failure). Fixed in two places.
- Question blocking leaked across employers: one shared question row carried whichever form's required flag came first. Now decided per application.
- Real Greenhouse/Lever/Ashby forms show captchas; approved real applications on those will usually land in Submit by hand with copy buttons.
- Some generated questions are low value for Devin ("Have you written HTML markup in your web projects?"), and a few Lever labels carry widget text ("Couldn't auto-read resume").
- Shared question rows keep the context sentence of the first application that asked (CompanyCam's LinkedIn card says the field is optional on the sandbox form). New questions use neutral context.

- Resume PDFs never worked on the deployed app: pdf.ts loaded pdfmake with a dynamic require that the build trace drops. Fixed (66d0052); prod now serves the PDF.
- Local Docker on macOS fakes file ownership on bind mounts, so permission tests there prove nothing; the privilege tests were rerun on a named volume.

- The Anthropic key answered only on `claude-haiku-4-5` in the morning (every other model returned 429 "Error"). By 10:34 Central Opus 5.5 answered again, and at 10:34 the account ran out of credit: every Claude call now fails with "Your credit balance is too low".
- Coolify passes every env var into the Docker build as a build ARG, so secrets like `NUXT_SESSION_PASSWORD` reach the build stage (Docker warns about it). They are not baked into the final image layers.
- The first foundation deploy failed: Nitro's trace leaves `playwright-core/cli.js` out of the build output. Fixed by installing Chromium from the builder's node_modules.

- Coolify never auto-deployed: the app uses the public-repo source and the repo had no webhook. Added a GitHub push webhook to `Devin345458/job-hunter` pointing at Coolify's manual GitHub webhook with a new secret on the Coolify app. Ping returned 200. The resume app has the same setup (no webhook), so "deploys on push" is not true there either.

- Mobile production first paint shows only the full-screen navigation drawer before the app hydrates (layout shift 0.31). Present before this run; found by the peer walk.
- The mobile bottom nav label "Knowledge Base" wraps to two lines at 390px.

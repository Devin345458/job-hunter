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

- [ ] Fix Adzuna query. Report JSearch subscription as blocked.
- [ ] Add sources whose listings link to real employer application forms (Greenhouse, Lever, Ashby boards).
- [ ] Enrichment: fetch the full posting, resolve the apply URL, detect the ATS.
- [ ] Extract salary and benefits from the posting with quotes from the source text.
- [ ] Total compensation estimate against the floor and preferences in the knowledge base. Ask a question when a preference is missing instead of guessing.
- [ ] Score = skills fit + compensation fit + learned adjustment, with the breakdown stored and shown.
- [ ] Verified on prod with listings pulled today.

## Capability B: prepare each application

- [ ] Tailored resume (reframe only, every claim traceable to the knowledge base) and PDF.
- [ ] Cover letter.
- [ ] Form engine: open the employer form with Playwright in the container, extract fields, answer from the knowledge base, fill, screenshot, never submit. No file attach in the dry run.
- [ ] Unknown facts become questions. EEO fields are never inferred.
- [ ] Account-required ATS (Workday, iCIMS, Taleo, SuccessFactors) routed to manual, never an account created.
- [ ] Gap analysis: per missing requirement, decide whether a demo project would close it.
- [ ] Demo project build: real working code with tests, staged in the data volume, unpushed.
- [ ] On approve only: push the demo to GitHub, add it to the resume site, then submit the form.
- [ ] Filled but unsubmitted applications on real employer forms from listings pulled today, on prod.

## Capability C: review dashboard

- [ ] Queue shows job, match reasoning, compensation, resume, cover letter, filled answers with screenshot, and demo project.
- [ ] One-tap approve and reject. Reject asks for a reason. Only approve submits.
- [ ] Clearable in five minutes a day on a phone.
- [ ] None of the banned defaults: cream or off-white backgrounds, italic accent words in headings, numbered section labels, monospace labels, pill buttons.

## Capability D: learning

- [ ] Plain questions: "Have you done X?", "Do you know language Y?", answers stored in the knowledge base.
- [ ] Every approve and reject recorded with the reason.
- [ ] Rejection reasons become learned rules that adjust search and scores.
- [ ] Five rejections for one reason visibly move the next day's scores (score history shown).

## Verification passes (at least three)

- [ ] Pass 1: deployed dashboard, every element clicked at desktop and mobile width, console and network clean.
- [ ] Pass 1: pipeline on today's listings through a filled, unsubmitted application on a real employer form.
- [ ] Pass 1: submit exercised only against the sandbox form.
- [ ] Pass 1: scheduled tasks fire in the container (pipeline_runs and docker logs).
- [ ] Pass 2: same four checks.
- [ ] Pass 3: same four checks.

## Found during the run

- The Anthropic key answers only on `claude-haiku-4-5`. Every other model (Opus 5.5, Sonnet 5.5, Haiku 5.5, Opus 4.x, Sonnet 4.6) returns 429 with the message "Error", although `models.list` shows them. Likely a zero rate or spend limit on the workspace.
- Coolify passes every env var into the Docker build as a build ARG, so secrets like `NUXT_SESSION_PASSWORD` reach the build stage (Docker warns about it). They are not baked into the final image layers.
- The first foundation deploy failed: Nitro's trace leaves `playwright-core/cli.js` out of the build output. Fixed by installing Chromium from the builder's node_modules.

- Coolify never auto-deployed: the app uses the public-repo source and the repo had no webhook. Added a GitHub push webhook to `Devin345458/job-hunter` pointing at Coolify's manual GitHub webhook with a new secret on the Coolify app. Ping returned 200. The resume app has the same setup (no webhook), so "deploys on push" is not true there either.

- Mobile production first paint shows only the full-screen navigation drawer before the app hydrates (layout shift 0.31). Present before this run; found by the peer walk.
- The mobile bottom nav label "Knowledge Base" wraps to two lines at 390px.

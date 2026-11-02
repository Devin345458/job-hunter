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
- [ ] Clearable in five minutes a day on a phone. Timed on production at 390: all 10 cards in 2 min 37 s of agent time (3 sandbox decided, 7 real cards to the decision point), estimated 3 to 4.5 minutes for a person. Slowed by the toast over the navigation and navigation that scrolls away; both in `rewalk-fixes`. Ticks after those land.
- [x] None of the banned defaults: cream or off-white backgrounds, italic accent words in headings, numbered section labels, monospace labels, pill buttons. Checked on every page at 1280 and 390 on production (commit 802c1b9) by computed style: buttons and chips 6 to 8px radius (up to 151 buttons on one page), body rgb(15, 19, 24), no italic in headings, no numbered labels, no monospace labels (the check flagged the demo build log, which is meant to be monospace, so it works).

## Capability D: learning

- [x] Plain questions with one-tap answers; answers write the knowledge base (negative answers too) and refresh every waiting application.
- [x] Every approve and reject recorded with the reason and a job feature snapshot.
- [x] Rejection reasons become learned rules (score, exclude from search, boost). Sandbox decisions only make sandbox rules.
- [x] Five rejections for one reason visibly move the next day's scores. Prod proof on sandbox jobs: five Not remote rejections made onsite and hybrid rules of -15; open onsite job 99 to 84, remote job unchanged; score history records the move.

## Verification passes (at least three)

- [ ] Pass 1: deployed dashboard, every element clicked at desktop and mobile width, console and network clean.
  - 2026-11-02, commit 802c1b9, qa-walker: FAILED. 12 major and 22 minor defects; no 4xx or 5xx from the app; one JS error once (`Cannot read properties of null (reading 'trim')` on /applications/14). Being fixed in worktrees `fix-review` (errors shown raw, run status, review cards, questions) and `fix-shell` (jobs pages, navigation, layout). Re-walk after merge.
  - [x] `fix-review` merged (7115742 to 8835b25): plain errors everywhere (M2, M3, m22), one outcome per run with partial in amber (M4), Prepare again instead of copy instructions (M9), per-employer question context on review cards (M10), collapsing Answered and Skipped (M12), cleaned form labels and neutral dry-run file notes (m2, m3), plain names (m4), rendered README and posting paragraphs (m5, m8), plurals (m7), phone health line and full-size screenshot (m12, m13). Evidence checked: before and after screenshots at both widths, copied to the scratchpad `evidence-fix-review/`. Not fixed there: Questions page still shows the first employer's context for a shared question; "asked you as question #N" wording.
  - [x] Follow-ups on main: plain wording for key and budget stops, real plurals in gaps.ts, submit.ts, approve.post.ts (7e1977d); manual enrich and match runs honor jobIds (dffdb09); healthcare and trades tech lead titles filtered out (a04bf78).
  - [x] Question numbers replaced by "the Questions page" in form answer sources and pay notes (bff96d0); the approve bar says what approve will actually do, and approve is refused with a reason when a built demo cannot publish (6e80924, live; prod CompanyCam reports the demo block).
  - [x] `fix-shell` merged after checking its screenshots: labeled Search now with a confirm, logged in pipeline_runs (M1); real total with Load more (M5); latest request wins (M6); readable cards and filters (M7); floating buttons clear of the bottom bar (M8); Demo projects in the menu (M11); 44px phone targets and darker scrims (m1, m21); one name for Applications (m14); job actions under the header on phones (m15); Knowledge base header and default category (m17); accessible names (m19); best match first with a Newest toggle. Plus one Remote chip and "Found on Ashby" on the job page (c581a75).
  - [x] `fix-questions` merged after a personal-data scan of its diff: code comments used Devin's real street address and ZIP as examples. Replaced with a made-up address and squashed so the values never entered the public history. Verified on a production copy: city and state answered from the stored address, the reworded duplicate merged, initials answered as DHG, Spotify and AppFolio unblocked, a second learn:daily changed nothing, no job score changed. On production (run 142): pending questions 36 to 31, blocking 5 to 2.
  - [x] Questions page lists every application waiting on a question, one row each (f942433, live).
  - [x] Re-walk on f942433 at both widths (qa-walker, 2026-11-02 10:52 to 11:45 Central): 23 of the first walk's defects fixed, 6 partly, 3 still present, 2 not reproduced; 63 captured states with no console errors; the only 4xx were a deliberate wrong password and post-sign-out calls. New: one major (CompanyCam hides why approve is off for its demo and still promises a publish) and 12 minor. I read the key screenshots myself. Fixes in worktree `rewalk-fixes` (and two demo-page items in `demo-preview`).
- [x] Pass 1: pipeline:daily on prod, 2026-11-01 10:16: search, enrich, match, prepare. Four real forms filled and not submitted (CompanyCam and 1Password and AppFolio on Ashby, Brilliant on Lever), screenshots served; no files attached; one demo built.
- [x] Pass 1: answered the two blocking questions and approved the sandbox card in the deployed UI; it reached `submitted` (reference 1) after two fixes (sandbox relabeled by enrichment; sandbox detection now uses the opened URL). Real submits stay off.
- [x] Pass 1: the 15 minute heartbeat fired on schedule in every deployed container (pipeline_runs host = container id from /api/health).
- [ ] Pass 2: same four checks.
  - [x] Scheduler: the daily chain fired on its own schedule at 06:00 Central on 2026-11-02 (pipeline_runs 95, trigger `schedule`), and the heartbeat kept firing every 15 minutes through the night.
  - [x] Login sweep: 47 routes, every protected route 401 without a session.
  - [x] Pipeline on today's listings: Devin's manual pipeline:daily at 15:34 UTC on the new token (run 125): 40 enriched, 47 scored, 0 failed; the five credit-failed applications prepared again, and three real employer forms were filled and not submitted (Spotify and Metabase on Lever, AppFolio on Ashby), each stopped at a captcha and waiting on answers. The last step (demos:build, run 131) was cut off by my deploy at about 15:42; the two credit-failed demos retry on the next run.
  - [x] Sandbox submit: both sandbox applications (11, 12) had found no form fields because their jobs still pointed at the sandbox posting page (enriched before the guard). Fixed in 4a0b7ad. Re-filled on production (20 fields, 16 filled each, no open questions), then approved application 11 in the deployed dashboard at 16:12 UTC: status submitted, sandbox confirmation "Reference number 2", 18 fields and the 37 KB resume PDF stored. Real submits stay off.
  - [x] Browser click-through at both widths: walked on f942433 (second walk). Its one major (CompanyCam hid why approve is off for its demo) and 15 minors are fixed in `rewalk-fixes` (fbd3fd9 to 5a9fcbb, live); I read its before and after screenshots, and the final walk rechecks them on production.
- [ ] Pass 3: same four checks.
  - [x] Scheduler: the first slot of the new every-3-hours schedule fired at 12:00 Central (pipeline_runs 147, trigger `schedule`) in the deployed container 2282da270ab3, the one /api/health reported, with every step chained.
  - [x] Pipeline on today's listings: run 147 found 298 (1 new), enriched 40, scored 40 with 0 failures, asked 2 skill questions, and prepared 5 new real applications with forms filled and not submitted (Vanta twice for two different teams and Temporal on Ashby, Veeva on Lever, Calendly on Greenhouse; 11 to 18 fields filled each, each stopped at a captcha), and built one demo (Temporal). Login sweep after the deploy: 48 routes, 0 unexpected.
  - [ ] Sandbox submit on the final build: in the final walk (applications 23 and 24 seeded and prepared on production at 12:40; enrich and match touched only those two, which also proves manual runs honor jobIds).
  - [ ] Browser walk on the final build (4b22aa0, qa-walker running), with the sandbox submit on application 23 or 24.

## Found during the run

- 2026-11-02: gap questions about experience no code can show ("Have you given a live product demo at an event?") said "The answer decides whether a demo project should be built". Now they say the answer decides what the resume and letter can mention, and a No skips the demo decision (1b5b407).
- [x] 2026-11-02: a bare Yes gave the resume and letter nothing to cite. A Yes or Some experience now asks "Where did you do it?" and stores the example in your own words in the knowledge entry; older yes answers show "Add an example" and a count; the chat can help write one from what you type (82da474, merged 7a4065b). Checked from its screenshots at 1280 and 390.
- [x] 2026-11-02: the evidence check removed the employer from a claim backed by your own example ("At Applied Imagination I demoed ...") because the example lives under a skill entry. A claim may now name an employer when the verified quote names it; an employer added to a skill entry that never names it is still rejected. Three-case test: the example case failed before the fix and passes after; both safety cases still reject (88d2455).
- [x] 2026-11-02: the gap reader asked "Do you have the legal right to work permanently in the United States?" as an experience question although the profile has Work Authorization (US). Work authorization, sponsorship, citizenship, residency, relocation, clearance, time zone, and degrees are now never gap questions, and pending ones close with a note (on a production copy only question 83 matched) (88d2455).
- [x] 2026-11-02: a long skill chip pushed /review/4 to 451px at 390. Chips wrap inside the card; /review/4, /review/14, /review/2 measure 390 at 390 (88d2455).
- 2026-11-02, not fixed: the type check reports errors that do not change behavior (an unreachable fallback in reject-skills.ts, a header typed as a number in login.post.ts, a loose error type in ai.ts, a missing pdfmake declaration, a possibly undefined value in jobs/[id].vue, and a type too deep to compare in demos/[id].vue). `npm run build` does not type check, and every one was read in place.
- 2026-11-02: demo previews run model-written code. Served from a token link with a CSP sandbox and no network; on production, from inside the preview, the session cookie, /api calls, and storage were all blocked (opaque origin).

- 2026-11-02: agent worktrees run the production build, so each local server also ran the cron schedule (now every 3 hours): Claude calls through the TeamClaude proxy and dry-run fills on real employer forms from laptop copies. Two such servers were left running from removed worktrees; stopped. NUXT_SCHEDULER_ENABLED=false now turns the schedule off, and the worktree setup writes it (f2429b8).
- 2026-11-02: the same role posted for several locations (Samsara six times, Discover and Lemon.io three times) could each become its own application. One application per role now (ee7ca43).
- 2026-11-02: the pipeline prepared a product manager role (Temporal, Senior Staff Technical Product Manager) at a match score over 70. The title filter only removes sales, support, hardware, healthcare, and trades titles; a reject for the right reason teaches the scores.

- 2026-11-02: the text answer box on Questions was single line with a 500 character limit, so a long, multi-line answer (Devin's AI experience answer, about 1,450 characters with bullets) could not be entered. The server accepts 4,000. Moving to a growing text area in `question-chat`. Separately, a single-line employer field (CompanyCam's is an <input>) drops line breaks when filled; the filler now joins lines readably (f478ca9).
- 2026-11-02: the five-a-day cap on skill questions hid low-quality questions from jobs that score poorly. Removed the cap, ask only from jobs scoring 50 or more, right after scoring, ordered by value (155c539). The pipeline now runs every 3 hours from 6 AM to 9 PM Central; it had run once a day with about 250 postings unread.

- 2026-11-02: Devin switched NUXT_ANTHROPIC_API_KEY to a Max subscription OAuth token (sk-ant-oat01) for this personal project. The app's SDK accepts it; Haiku 4.5 answers, Opus 5.5 returns 429 on this direct-API path, so the app runs on its Haiku fallback. Anthropic's current legal and compliance page assumes "ordinary, individual usage of Claude Code and the Agent SDK" on Pro and Max, and limits its API-key requirement to developers building products for others; my first reading quoted the February 2026 wording, since rewritten. Option for Opus: Max includes $100 a month of API credit for a Console organization linked to the plan.
- 2026-11-02: a 401 from Anthropic (rejected key) was not a run stop; each job and application would have been marked failed. Now it stops the run like running out of credit (bb4932a).
- 2026-11-02: I deployed while Devin's manual pipeline run was in its demos:build step and the restart cut it off. Check /api/pipeline/runs for a running run before every push.
- 2026-11-02: the approve bar promised "Sends the application to Brilliant" on real cards, but with NUXT_REAL_SUBMIT_ENABLED unset (and captchas on Spotify, Metabase, and AppFolio) approve only marks the card for a submit by hand. And approving a card with a built demo (CompanyCam) without NUXT_GITHUB_TOKEN would have failed at publish after recording the approve. Both fixed in 6e80924.
- 2026-11-02: the match reasoning called Devin "He". The scoring and gap prompts now address the job seeker as "you"; stored reasoning updates as jobs are rescored.
- 2026-11-02: Adzuna returned "Sterile Processing Tech Lead" and it passed the title filter through "tech lead"; it cost two Claude calls before scoring 0. Filter tightened (a04bf78).
- 2026-11-02: the question step asked the home address four ways (ZIP, street, city and state twice) and asked for initials although the profile has the full name. Fixed (49fd2ae).

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

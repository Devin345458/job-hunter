# AGENTS.md

## Project
- Name: `job-hunter`
- Purpose: Automated job discovery, AI matching, resume tailoring, and application tracking.
- Runtime: Nuxt SSR app with Nitro server routes and scheduled tasks.

## Tech Stack
- Nuxt `^4.3.1` + Vue `^3.5`
- Vuetify `^3.11` via `vuetify-nuxt-module`
- TypeScript (app + server)
- Drizzle ORM + `better-sqlite3`
- SQLite database (default: `./data/job-hunter.db`)
- PDF generation with `pdfmake`

## Key Directories
- `app/`: pages, layouts, components, composables, styles
- `server/api/`: Nitro API endpoints
- `server/tasks/`: scheduled job search + match tasks
- `server/utils/job-sources/`: pluggable job source adapters
- `server/db/`: schema, migrations, seed script
- `data/`: SQLite files

## Dev Commands
- Install: `npm install`
- Dev server: `npm run dev`
- Production build: `npm run build`
- Preview build: `npm run preview`
- Generate migrations: `npm run db:generate`
- Apply migrations: `npm run db:migrate`
- Seed data: `npm run db:seed`
- Drizzle Studio: `npm run db:studio`

## Environment Variables
- Required:
  - `NUXT_ANTHROPIC_API_KEY`
  - `NUXT_AUTH_PASSWORD_HASH` (from `node scripts/hash-password.mjs`; without it every route stays locked)
  - `NUXT_SESSION_PASSWORD` (32+ random characters)
- Optional:
  - `NUXT_SANDBOX_TOKEN` (16+ chars; enables the throwaway employer form at `/sandbox/apply/<token>`)
  - `NUXT_PUBLIC_BASE_URL` (e.g. `https://job-hunter.devinsmini.com`)
  - `NUXT_AI_MODEL` (default `claude-opus-5-5`), `NUXT_AI_FALLBACK_MODEL` (default `claude-haiku-4-5`)
  - `NUXT_DAILY_AI_BUDGET_USD` (default 10)
  - `NUXT_GITHUB_TOKEN` (push access for demo repos and the resume site; used only on approve)
  - `NUXT_GITHUB_READ_TOKENS` (comma separated read-only fine-grained tokens for GitHub evidence, one per owner, with Contents, Metadata, and Pull requests read access) or `NUXT_GITHUB_READ_TOKEN` (one token). With neither set, GitHub evidence reads with `NUXT_GITHUB_TOKEN`.
  - `NUXT_REPO_UID` (default 10002; the unprivileged user git runs as for the GitHub evidence cache in the container)
  - `NUXT_JSEARCH_API_KEY`
  - `NUXT_ADZUNA_APP_ID`
  - `NUXT_ADZUNA_API_KEY`
  - `NUXT_DATABASE_PATH` (defaults to `./data/job-hunter.db`)
  - `NUXT_DEMOS_ENABLED` (`false` switches demo builds and demo publishing off; production since 2026-11-03)
  - `NUXT_SCHEDULER_ENABLED` (`false` turns off the cron schedule; every Orca worktree sets it; production leaves it unset. Manual runs still go to the job queue and the worker still runs them)
  - `NUXT_ROLE` (`all` default, `web`, or `worker`; see Job queue below)
  - `NUXT_WORKER_CONCURRENCY` (default 1, at most 4; queue items the worker runs at once. Demo builds and Chromium form fills never run two at a time regardless)
  - `NUXT_BULK_CONCURRENCY` (default 4, at most 8; per-job read and score items the worker runs at once)
  - `NUXT_PIPELINE_CRON`, `NUXT_HEARTBEAT_CRON` (tests only: override the daily cron and the 15 minute heartbeat; production leaves them unset)
  - `NUXT_MEMORY_MCP_URL` (Devin's claude-self-reflect memory server, e.g. `http://127.0.0.1:7391/mcp`; production reaches it over Tailscale; empty turns memory leads off)
  - `NUXT_MEMORY_MCP_HOST_HEADER` (default `127.0.0.1:7391`; sent as the Host header when the memory URL's host is not local, because the daemon rejects any other Host)

## Implementation Conventions
- Prefer TypeScript-first changes with explicit types for API payloads and DB interactions.
- Preserve source adapter contract in `server/utils/job-sources/types.ts`.
- Keep deduplication behavior stable (`source + sourceId`).
- Keep AI behavior conservative: tailor existing experience, never fabricate claims.
- Use SCSS + BEM naming for custom styles.

## Nuxt + Vuetify Notes
- Vuetify config lives in `nuxt.config.ts`.
- Vuetify SASS settings live in `app/assets/scss/components.scss` (`moduleOptions.styles.configFile`). Every component's styles compile through it, so font and radius overrides go there. `global.scss` loads it first, then the full `vuetify` stylesheet.
- `disableVuetifyStyles: true` is intentionally enabled to avoid broken `/_nuxt/vuetify/styles` requests in dev.
- MDI icons load through Vuetify's icon set; the MDI font ships in the built CSS. `nuxt.config.ts` computes `mdiCssPath` and two related constants that nothing uses yet. Dev still logs a 404 for `/_nuxt/@mdi/font/css/materialdesignicons.css`; production does not.
- The mobile app bar and bottom navigation bind `model-value`/`active` to `!isDesktop`. A `d-md-none` class alone hides them but leaves their 64px and 56px reserved in Vuetify's layout.

## Pipeline architecture (added 2026-11-01)
- Login: `server/middleware/00.auth.ts` gates every page and `/api/*` route. Public: `/login`, `/api/auth/*`, `/api/health`, build assets, and the sandbox form (token-checked).
- Shared contract: `shared/types/pipeline.ts` defines every JSON column shape and the `ReviewItem` the dashboard reads. Change it first.
- Data model: migration `0001_pipeline_learning_demos` adds job enrichment and scoring columns, application pipeline columns, and the tables `decisions`, `learned_rules`, `demo_projects`, `pipeline_runs`, `score_history`, `sandbox_submissions`, `ai_calls`.
- Claude calls go through `aiStructured()` / `aiText()` in `server/utils/ai.ts`: structured outputs, model fallback, cost logging to `ai_calls`, daily budget.
- Tasks: `pipeline:daily` (every 3 hours, 06:00 to 21:00 America/Chicago; `PIPELINE_CRON` in shared/utils/schedule.ts) runs the `DAILY_STEPS` in order (`repos:index`, `learn:daily`, `jobs:search`, `jobs:enrich`, `jobs:match`, `applications:read-forms`, `demos:build`, `repos:suggest`, `memory:leads`), each as a job queue item (below). Every run writes `pipeline_runs`. `POST /api/pipeline/run {task}` queues one by hand.
- Run outcomes: `shared/utils/run-outcome.ts` turns a run's stats into `outcome` (succeeded, partial, failed) and `problems` ("38 failed", "stopped: out of credit"); `pipeline:daily` records its steps' problems. `GET /api/pipeline/runs` leaves out scheduler heartbeats (`?heartbeats=1` keeps them) and returns `lastDaily` and `lastHeartbeat` on their own.
- Stored errors: never render `status_detail`, `form_error`, `submit_error`, `enrich_error`, or a demo error raw. `plainError()` in `shared/utils/plain-text.ts` gives one plain sentence (no JSON, stack, or internal prefix); `setApplicationStatus()` stores details through it. `cleanFieldLabel()` drops widget text from form labels.
- Review: `GET /api/review/queue`, `GET /api/review/:id`, `POST /api/review/:id/apply` (stage 1), `POST /api/review/:id/approve`, `POST /api/review/:id/reject {reasonCode, reasonText, skills?, skillsMode?}`. A Wrong tech stack reject can name skills (`server/utils/reject-skills.ts`): learning then makes evidence only for them, and skillsMode `lack` writes each one to the knowledge base as a No and answers pending knows/has_done questions about it with No; `avoid` writes nothing. Approve is the only path to `runApproval()` in `server/utils/approval.ts`, which is the only caller of `publishDemo()` and `submitApplication()`.
- Files the app writes (resumes, screenshots, demo repos, sandbox uploads) go under `dataDir()`, next to the database, so they land on the persistent volume.
- Form labels: `matchFact(field, snapshot.fields)` reads a label among its neighbors. A start date inside an education or work history group (Greenhouse's "Start date month" after School and Degree) is not the availability question (`isHistoryDate()` in `server/utils/facts.ts`). `refreshStoredAnswers()` releases a field still waiting on such a misread fact question and skips the question when no field of any application waits on it.
- Browser: `launchBrowser()` / `newBrowserContext()` in `server/utils/browser.ts`. The Docker image installs Chromium at the bundled Playwright version.

## Job queue (added 2026-11-03)
- Nothing runs in a request or on an in-process timer anymore. Every scheduled run, manual trigger, and background job is a row in `task_queue` (migration `0005_task_queue`, CREATE TABLE only): task, payload, status (queued, running, done, failed, canceled, interrupted), attempts and max attempts, lease owner and expiry, run after, times, the `pipeline_runs` id, the parent (daily run), the last error (through `plainError()`), a note ("Resumed after a restart"), shared progress, and a result. Code: `server/utils/queue.ts` (store, claim, leases, resume, daily chain, views), `server/utils/queue-run.ts` (what each kind of item runs), `server/plugins/queue.ts` (worker loop, schedule, graceful stop), `server/utils/role.ts`.
- Producers call `enqueue()`: the schedule (`pipeline:daily` on `PIPELINE_CRON`, `system:heartbeat` every 15 minutes, both with croner in `server/plugins/queue.ts`; `nitro.scheduledTasks` is gone), `POST /api/pipeline/run`, `POST /api/jobs/search` (waits up to 60 seconds, under Cloudflare's 100 second limit, then answers 202 queued), `POST /api/repos/find` (`repos:find`), new questions (`queueRepoSuggest()`, a `repos:suggest` item 45 seconds out that later questions join), approve (`applications:approve`), Prepare and Prepare again (`applications:prepare-one`), Refill (`applications:refill`), demo rebuild and preview (`demos:rebuild`, `demos:preview`). `?wait=true` on the prepare and refill routes waits on the item. Still inline (they answer the request with a result and start no task): `POST /api/jobs/match`, `POST /api/jobs/:id/rescore`, `POST /api/demos/analyze`, `POST /api/applications/:id/refresh-answers`, `POST /api/pipeline/browser-check`, and the note mapping after a decision.
- Worker: claims the oldest due item with one atomic `UPDATE ... RETURNING` and a 30 second lease, renewed every 10 seconds; runs Nitro tasks with `runTask` unchanged and writes `pipeline_runs` through `withRun()` as before. Lanes: main runs one item at a time (`NUXT_WORKER_CONCURRENCY`); per-job items run four at a time in their own lane (`NUXT_BULK_CONCURRENCY`), so a backlog never holds up an approval; the enrich and match steps wait in their own lane; the heartbeat may run beside a long item. Never two of the same task (per-job items excepted), and never two heavy ones (`HEAVY_TASKS`: demo builds and previews, preparations, refills, approvals) at once, across processes.
- Reading and scoring, one item per job, no cap (`server/utils/queue-jobs.ts`): `jobs:search` queues a `jobs:enrich-one` item for every new job; an enrich-one that read its posting queues the job's `jobs:match-one`. The `jobs:enrich` and `jobs:match` steps (full run, or Run in Settings) queue an item for every job still waiting that has none (enrich: prefilter first, best candidates first), wait for all of them, and write one `pipeline_runs` row with the counts (`enriched`, `scored`, `failed`, `pending` = still waiting); per-job items write no run row. The full run's row carries `enriched`, `scored`, and `pending` too. The daily budget is checked before every Claude call (enrich-one checks `aiStopError()` before fetching anything): a job the budget stops ends `budget`, stays waiting, and the next run after the budget resets queues it again; it is never marked failed for that. `ENRICH_LIMIT` and `MATCH_LIMIT` now cap only the inline `POST /api/jobs/match`. Search and enrich queue their follow-on only where the schedule is on (`autoFollowOn()`), so a worktree spends no Claude credit on its own. Settings and the Review page count per-job items ("Reading postings: 4 now, 37 waiting") instead of listing them; they are pruned after two days.
- Preparing one application: `queuePrepare(applicationId)` in `server/utils/queue.ts` (an `applications:prepare-one` item) is the one call Apply, Prepare from a job page, Prepare again, and the read-forms step (stopped preparations) make.
- Daily run: the `pipeline:daily` item writes its `pipeline_runs` row, queues one child item per step, and frees the worker. A step starts when the one before it ends (failed steps do not stop the chain) and then goes to the front of the queue, so an approve made during a daily run waits for the current step only. After the last step the daily row gets `steps` and `problems` exactly as before. One daily run at a time: queuing another returns the one in flight.
- Resume after a restart: a worker whose process died leaves its lease to run out; the next worker start (or any worker within 30 seconds) puts the item back in the queue with attempts plus one, and the next attempt carries the same `pipeline_runs` row on, marked `resumedAfterRestart` ("succeeded, resumed after a restart" in the run log). After 3 starts it fails. What a rerun does: search dedupes on `source + sourceId`; enrich and match pick rows still pending, so they continue where they stopped; prepare retries rows left in preparing that no queue item holds (`pickRetries`); demos:build builds a demo the restart cut off again first, in a fresh directory (`BUILD_INTERRUPTED`); a rebuild starts its build over.
- Never repeat a submit: an `applications:approve` item cut off mid-run is marked `interrupted`, never retried. `markApprovalInterrupted()` moves the application to `submit_failed` (approve can retry it) with "Interrupted while submitting; check the employer's site before you submit again" when it was submitting, or a "nothing was submitted" sentence when it stopped earlier, and puts a demo left in publishing back to built. Publishing again reuses the GitHub repo that already holds this history and skips a resume card that is already there, so it never makes a second repo or card.
- Graceful stop: on SIGTERM the worker stops claiming, gives the running item up to 25 seconds (Nitro allows 30), then ends its lease so the next start resumes it. `docker-compose.yml` sets `stop_grace_period: 35s`; a platform that kills sooner only means the item waits for its lease to run out (30 seconds) before it resumes.
- Roles (`NUXT_ROLE`, one image): `all` (default; today's single container: web, schedule, worker), `web` (serves the app and enqueues; no schedule, no worker), `worker` (schedule and worker; every path but `/api/health` answers 404). Two processes on one database file work: WAL plus `busy_timeout = 5000`, write transactions for check-then-insert. Live progress the worker shares on its item (`shareProgress()`: demo build turns and lines, the commit search counts) is what a web process shows (`sharedProgress()`); `demoBusy()` and `previewBusy()` read the queue, not memory. `/api/health` returns the role and the queued and running counts.
- Dashboard: `GET /api/pipeline/runs` returns `queue` (running, waiting, daily runs under way, and the last day's interrupted, failed, canceled, and resumed items). Settings > Pipeline lists it with Cancel on waiting items (`POST /api/pipeline/queue/:id/cancel`; a full run under way loses its waiting steps; approvals and preparations are not cancelable); the Review page health panel shows the running item and what waits, or an interrupted approval. Text comes from `shared/utils/queue-text.ts` ("Waiting: Score matches, queued 2 minutes ago").
- Deploys: a push to main still restarts the container, which pauses the queue until it is back. Nothing is lost and no run needs to be held for: the item that was running resumes from where its task left off, and waiting items keep their place. One exception: if Settings > Pipeline shows "Running: Submit an approved application", wait for it, because a restart ends that one interrupted and Devin then has to check the employer's site before approving again.

## Decide first (added 2026-11-03)
- Two stages. Stage 1 (Decide, status `to_decide`): for every job scoring at or above 70 (`DECIDE_THRESHOLD`), `applications:read-forms` (the daily step where `applications:prepare` used to be, at most 12 forms a run) creates the application row, stores the gap plan (`analyzeGaps`), and reads the employer form in Chromium without filling it (`readForDecision()` in `server/utils/apply/decide.ts`). `deriveAnswers(..., { mode: 'decide' })` fills personal facts, maps options (`form_option_map`), and asks a question for each fact the form needs; every field that needs Claude's judgment is marked `atApply` and nothing is written for it. No tailor, cover letter, or form_answers call happens before Apply. A job without an apply link or with an account-only ATS gets a card too, with `form_error` saying it goes by hand.
- The review card at stage 1 shows the score, pay, Matched and Missing, the gap plan, the form read, the form's questions ("The form asks") and the gap plan's ("Skills to confirm"); neither blocks Apply. Buttons: Apply and Reject (the materials reason is not offered). A Decide card leaves the queue while its job scores under 70 or is closed (`decideCardVisible()`); the row stays.
- Apply (`POST /api/review/:id/apply`, or Prepare on a job page, `POST /api/applications/:jobId`) records decision `apply` and queues `applications:prepare-one`: tailor plus check, cover letter plus check, form answers plus check, and the dry run with a screenshot. It skips the gap plan when stage 1 stored one, and reuses a stage-1 option mapping while its fact is unchanged (`FormAnswer.mappedFrom`). The card shows "Preparing: <step>" from `status_detail`, then comes back as a Send card (`proposed`, or `needs_input`) with Approve, which is unchanged and still the only path to a submit. Approve refuses `to_decide` (only `proposed`).
- Learning: `learningDecisions()` in `server/utils/learning.ts` counts Apply and Approve once per application as the positive signal (decision `approve` to `deriveRules`); a later Reject of the same application drops the positive. `approvedBefore` in the approve route and `submitApplication()` still look for a real `approve` decision.
- The read-forms step also queues stopped preparations again (`stoppedPreparations()`: budget, credit, restart, or a failed attempt under 3) and refreshes needs_input answers. `applications:prepare` stays as a task that only does the first of those; it never picks a job.
- Cost by stage: `server/utils/ai-stages.ts` maps each `ai_calls` purpose to a stage (Read postings, Score and gap plan, Read forms and questions, Prepare after Apply, Other); `GET /api/pipeline/runs` returns `aiStages` and Settings > Pipeline shows today and the last 7 days, with the prepare cost per applied application.

## GitHub evidence (added 2026-11-02)
- Purpose: suggest answers to pending `knows` and `has_done` questions from Devin's own commits. Code in a repo he can read is not code he wrote: only commits whose author email he listed, or that GitHub attributes to his login, count. The system only suggests (level Yes or Some experience, never No, plus commit links). Devin taps Use this and Save. No evidence shows nothing.
- Settings > GitHub evidence (`app/components/settings/GithubEvidence.vue`, `GET /api/repos`, `POST /api/repos/include`, `PUT /api/repos/identities`): repos grouped by owner. His own repos are on by default, except forks and this app's own repo (`Devin345458/job-hunter`, `isAppRepo()` in `server/utils/repos/settings.ts`), which names every skill as data: it is never switched on, indexed, suggested from, or searched. Organization and other people's repos are off, and turning one on shows the client code warning. Turning a repo off deletes its commits, facts, clone, and the suggestions citing it.
- Data (migration `0003_repo_evidence`, CREATE TABLE only): `repo_sources`, `repo_commits` (commit metadata, never diffs), `repo_facts` (languages, dependency names), `repo_suggestions` (one row per question: status suggested, none, or error, with the commit set it was judged from), `app_settings` (identities, unlisted emails).
- Tasks: `repos:index` is the first step of `pipeline:daily` (partial clones `--filter=blob:none --no-checkout` under `dataDir()/repo-cache`, his commits only, max 5,000 per repo, repos over 500 MB skipped). It clones or fetches at most 30 repos a run (`MAX_REPOS_PER_RUN`): never tried first, then the oldest index or attempt (`repo_sources.updated_at`, which a re-list no longer touches).
- Find repos with my commits (`server/utils/repos/commit-search.ts`, `POST /api/repos/find`, recorded as `repos:find`; also once a day at the start of `repos:index`): GitHub commit search by each login and each email not linked to a login, split by author date under the 1,000-result cap, waiting out the 30-a-minute limit (about 100 requests and 4 to 5 minutes for Devin). Counts per repo live in `app_settings` key `repo_commit_search`. A commit that only repos no token lists hold counts once, for the most-starred one, so copies of a project he contributed to drop out. Settings shows only repos with his commits plus switched-on ones until "Show all repos". `POST /api/repos/bulk` turns on the repos with his commits (never forks), per owner or all, or turns one owner off.
- SAML SSO: a 403 or git error naming SAML marks the repo skipped with "Authorize this token for <org> in GitHub (Configure SSO next to the token)" (`ssoMessage()`), never a failed run; `X-GitHub-SSO: partial-results` on a listing names the organizations too. `repos:suggest` is the last step and is queued within a minute of a new knows or has_done question (not where the schedule is off). Payload `{ questionIds }` limits it.
- Tokens: `server/utils/repos/github.ts` only. Git gets the token through `GIT_CONFIG_*` environment entries, never argv, never `.git/config`, never logs or API responses. In the container git runs as uid 10002 (`NUXT_REPO_UID`), not the demo uid, and nothing is ever checked out.
- Claude: one cheap call per subject for search terms (cached), one judge call per question when there are hits, and only when the hit set changed. Organization repo snippets reach Claude only after Devin turns that repo on.
- File paths: `repo_commits.paths_json` holds every changed path of his commits (from `git log --raw`, capped at 300 a commit). `signatureTerms()` in `server/utils/repos/search.ts` adds the files, folders, and packages a subject creates (GraphQL: `.graphql`, `schema.graphql`, `graphql/`; Shopify: `shopify.app.toml`, `.liquid`) to Claude's terms in `repos:suggest` and the chat, so a commit touching them counts even when its message does not name the subject.
- Chat search (`server/utils/repos/chat-search.ts`): the question chat and the general chat search his GitHub when he asks ("look through my github", `asksGithub()` in question-chat.ts) or when Claude sets the `githubSearch` field on a knows or has_done question. Order: his indexed commits (messages and paths, no diffs), then repo_facts, then GitHub code search with `repo:` qualifiers for switched-on repos that hold his commits only (never an org repo he has not switched on). The REST code search has no OR, so it spends one request per word (at most 4 a search; GitHub allows 10 a minute). The panel shows the findings as "Found in your GitHub" from `QuestionChatResponse.github`, never from Claude's text; a code search hit is labeled a lead. Drafts name a finding only after Devin types it himself.

## API and Data Safety
- Do not commit API keys or private profile data.
- Treat seeded resume/profile content as user-owned data; avoid overwriting without intent.
- Keep migrations additive and reversible where practical.
- Never submit an employer form, create an employer account, push to the resume repo or a public demo repo, outside the approve path.
- Never re-run an interrupted `applications:approve` queue item. It may have submitted; only Devin approving again starts a new one.
- Dry-run form fills never attach files; uploads happen only inside the approved submit.
- The production knowledge base holds every seeded row three times. Reads dedupe with `loadKnowledge()`; nothing deletes rows.

## Validation Checklist (before shipping)
- `npm run build` succeeds.
- Core pages load: `/`, `/jobs`, `/applications`, `/settings`.
- Core APIs respond: jobs search/match, stats, applications, knowledge, questions.
- No new console/server errors from Vuetify styles or icon assets.


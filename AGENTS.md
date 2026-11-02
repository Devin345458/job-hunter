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
  - `NUXT_GITHUB_READ_TOKENS` (comma separated read-only fine-grained tokens for GitHub evidence: Contents, Metadata, Pull requests read; one per owner) or `NUXT_GITHUB_READ_TOKEN` (one token). With neither set, GitHub evidence reads with `NUXT_GITHUB_TOKEN`.
  - `NUXT_JSEARCH_API_KEY`
  - `NUXT_ADZUNA_APP_ID`
  - `NUXT_ADZUNA_API_KEY`
  - `NUXT_DATABASE_PATH` (defaults to `./data/job-hunter.db`)
  - `NUXT_SCHEDULER_ENABLED` (`false` turns off the cron schedule; every Orca worktree sets it; production leaves it unset)

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
- Tasks: `pipeline:daily` (every 3 hours, 06:00 to 21:00 America/Chicago; `PIPELINE_CRON` in shared/utils/schedule.ts) runs `learn:daily`, `jobs:search`, `jobs:enrich`, `jobs:match`, `applications:prepare`, `demos:build` in order. Every run writes `pipeline_runs`. `POST /api/pipeline/run {task}` triggers one by hand.
- Run outcomes: `shared/utils/run-outcome.ts` turns a run's stats into `outcome` (succeeded, partial, failed) and `problems` ("38 failed", "stopped: out of credit"); `pipeline:daily` records its steps' problems. `GET /api/pipeline/runs` leaves out scheduler heartbeats (`?heartbeats=1` keeps them) and returns `lastDaily` and `lastHeartbeat` on their own.
- Stored errors: never render `status_detail`, `form_error`, `submit_error`, `enrich_error`, or a demo error raw. `plainError()` in `shared/utils/plain-text.ts` gives one plain sentence (no JSON, stack, or internal prefix); `setApplicationStatus()` stores details through it. `cleanFieldLabel()` drops widget text from form labels.
- Review: `GET /api/review/queue`, `GET /api/review/:id`, `POST /api/review/:id/approve`, `POST /api/review/:id/reject {reasonCode, reasonText, skills?, skillsMode?}`. A Wrong tech stack reject can name skills (`server/utils/reject-skills.ts`): learning then makes evidence only for them, and skillsMode `lack` writes each one to the knowledge base as a No and answers pending knows/has_done questions about it with No; `avoid` writes nothing. Approve is the only path to `runApproval()` in `server/utils/approval.ts`, which is the only caller of `publishDemo()` and `submitApplication()`.
- Files the app writes (resumes, screenshots, demo repos, sandbox uploads) go under `dataDir()`, next to the database, so they land on the persistent volume.
- Browser: `launchBrowser()` / `newBrowserContext()` in `server/utils/browser.ts`. The Docker image installs Chromium at the bundled Playwright version.

## GitHub evidence (added 2026-11-02)
- Purpose: suggest answers to pending `knows` and `has_done` questions from Devin's own commits. Code in a repo he can read is not code he wrote: only commits whose author email he listed, or that GitHub attributes to his login, count. The system only suggests (level Yes or Some experience, never No, plus commit links); Devin taps Use this and Save. No evidence shows nothing.
- Settings > GitHub evidence (`app/components/settings/GithubEvidence.vue`, `GET /api/repos`, `POST /api/repos/include`, `PUT /api/repos/identities`): repos grouped by owner. His own repos are on by default. Organization and other people's repos are off, and turning one on shows the client code warning. Turning a repo off deletes its commits, facts, clone, and the suggestions citing it.
- Data (migration `0003_repo_evidence`, CREATE TABLE only): `repo_sources`, `repo_commits` (commit metadata, never diffs), `repo_facts` (languages, dependency names), `repo_suggestions` (one row per question: status suggested, none, or error, with the commit set it was judged from), `app_settings` (identities, unlisted emails).
- Tasks: `repos:index` is the first step of `pipeline:daily` (partial clones `--filter=blob:none --no-checkout` under `dataDir()/repo-cache`, his commits only, max 5,000 per repo, repos over 500 MB skipped). `repos:suggest` is the last step and is queued within a minute of a new knows or has_done question (not where the schedule is off). Payload `{ questionIds }` limits it.
- Tokens: `server/utils/repos/github.ts` only. Git gets the token through `GIT_CONFIG_*` environment entries, never argv, never `.git/config`, never logs or API responses. In the container git runs as uid 10002 (`NUXT_REPO_UID`), not the demo uid, and nothing is ever checked out.
- Claude: one cheap call per subject for search terms (cached), one judge call per question when there are hits, and only when the hit set changed. Organization repo snippets reach Claude only after Devin turns that repo on.

## API and Data Safety
- Do not commit API keys or private profile data.
- Treat seeded resume/profile content as user-owned data; avoid overwriting without intent.
- Keep migrations additive and reversible where practical.
- Never submit an employer form, create an employer account, push to the resume repo or a public demo repo, outside the approve path.
- Dry-run form fills never attach files; uploads happen only inside the approved submit.
- The production knowledge base holds every seeded row three times. Reads dedupe with `loadKnowledge()`; nothing deletes rows.

## Validation Checklist (before shipping)
- `npm run build` succeeds.
- Core pages load: `/`, `/jobs`, `/applications`, `/settings`.
- Core APIs respond: jobs search/match, stats, applications, knowledge, questions.
- No new console/server errors from Vuetify styles or icon assets.


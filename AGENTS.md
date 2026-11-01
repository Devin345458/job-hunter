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
  - `NUXT_JSEARCH_API_KEY`
  - `NUXT_ADZUNA_APP_ID`
  - `NUXT_ADZUNA_API_KEY`
  - `NUXT_DATABASE_PATH` (defaults to `./data/job-hunter.db`)

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
- Tasks: `pipeline:daily` (06:00 America/Chicago) runs `learn:daily`, `jobs:search`, `jobs:enrich`, `jobs:match`, `applications:prepare`, `demos:build` in order. Every run writes `pipeline_runs`. `POST /api/pipeline/run {task}` triggers one by hand.
- Review: `GET /api/review/queue`, `GET /api/review/:id`, `POST /api/review/:id/approve`, `POST /api/review/:id/reject {reasonCode, reasonText}`. Approve is the only path to `runApproval()` in `server/utils/approval.ts`, which is the only caller of `publishDemo()` and `submitApplication()`.
- Files the app writes (resumes, screenshots, demo repos, sandbox uploads) go under `dataDir()`, next to the database, so they land on the persistent volume.
- Browser: `launchBrowser()` / `newBrowserContext()` in `server/utils/browser.ts`. The Docker image installs Chromium at the bundled Playwright version.

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


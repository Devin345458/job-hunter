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
- Optional:
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

## API and Data Safety
- Do not commit API keys or private profile data.
- Treat seeded resume/profile content as user-owned data; avoid overwriting without intent.
- Keep migrations additive and reversible where practical.

## Validation Checklist (before shipping)
- `npm run build` succeeds.
- Core pages load: `/`, `/jobs`, `/applications`, `/settings`.
- Core APIs respond: jobs search/match, stats, applications, knowledge, questions.
- No new console/server errors from Vuetify styles or icon assets.


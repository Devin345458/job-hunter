# Job Hunter

An automated job application system that finds matching jobs, scores them against your profile using AI, tailors resumes per application, and tracks everything in one place.

Built for the modern job market where applying at scale is necessary but manually tailoring each application is time-consuming. Job Hunter handles the tedious parts so you can focus on a quick daily review and click submit.

## How It Works

```
Search Configs ──> Job Source APIs ──> Normalize & Deduplicate ──> Store in DB
                                                                        │
                                                     AI Scoring (Claude) ◄─┘
                                                            │
                                              Matched Jobs Feed ◄─┘
                                                     │
                                    Generate Tailored Resume ◄─┘
                                              │
                              Application Tracker ◄─┘
```

1. **Configure searches** - Define keywords, salary range, locations, and which job sources to query
2. **Automated daily search** - Cron jobs find new listings at 6 AM and score them at 7 AM
3. **Review matched jobs** - Browse jobs sorted by AI match score, review why each scored high/low
4. **Generate tailored resumes** - AI reframes your experience to match each job description (never fabricates)
5. **Track applications** - Search by company name when they call back, see the exact resume you sent

## Features

- **Multi-source job aggregation** from 7 APIs (5 free, 2 optional paid)
- **AI job matching** scores each job 0-100 against your knowledge base
- **Resume tailoring** via Claude - restructures, reorders, and keyword-optimizes your resume per job
- **ATS-friendly PDF generation** using pdfmake (no Chromium dependency)
- **Knowledge base** stores your skills, experience, preferences - the AI's source of truth
- **Smart questions** - when the AI identifies gaps in your profile, it asks targeted questions
- **Application pipeline** - Draft > Ready > Submitted > Response > Interviewing > Offer
- **Interview prep view** - pull up the exact resume version, cover letter, and notes for any application
- **Scheduled tasks** - fully automated daily search and scoring via Nitro cron

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | [Nuxt 3](https://nuxt.com) (SSR + Nitro server) |
| UI | [Vuetify 3](https://vuetifyjs.com) (Material Design) |
| Database | SQLite via [Drizzle ORM](https://orm.drizzle.team) + better-sqlite3 |
| AI | [Claude API](https://docs.anthropic.com) (Anthropic) |
| PDF | [pdfmake](https://pdfmake.org) |
| Scheduling | Nitro built-in scheduled tasks |
| Deploy | Docker (any host - Coolify, Railway, VPS, etc.) |

## Quick Start

### Prerequisites

- Node.js 20+
- An [Anthropic API key](https://console.anthropic.com) for AI features

### Local Development

```bash
# Clone the repo
git clone https://github.com/Devin345458/job-hunter.git
cd job-hunter

# Install dependencies
npm install

# Set up environment variables
cp .env.example .env
# Edit .env and add your API keys (see Environment Variables below)

# Seed the database with your profile
# Edit server/db/seed.ts with your own resume data first
npm run db:seed

# Start the dev server
npm run dev
```

Open `http://localhost:3000` and you're running.

### Docker Deployment

```bash
# Clone and configure
git clone https://github.com/Devin345458/job-hunter.git
cd job-hunter
cp .env.example .env
# Edit .env with your API keys

# Build and run
docker compose up -d
```

The app will be available at `http://localhost:3000`. The SQLite database is persisted in a Docker volume (`job-hunter-data`).

## Environment Variables

```bash
# REQUIRED - Powers AI job matching, resume tailoring, and question generation
NUXT_ANTHROPIC_API_KEY=sk-ant-...

# OPTIONAL - Expands job coverage (see Job Sources section below)
NUXT_JSEARCH_API_KEY=your-rapidapi-key
NUXT_ADZUNA_APP_ID=your-app-id
NUXT_ADZUNA_API_KEY=your-api-key

# Database location (default: ./data/job-hunter.db)
NUXT_DATABASE_PATH=./data/job-hunter.db
```

### Which API keys do I actually need?

**Only `NUXT_ANTHROPIC_API_KEY` is required.** The app works out of the box with 5 free job sources that need no API keys (Remotive, RemoteOK, Himalayas, Jobicy, Arbeitnow). JSearch and Adzuna are optional additions for broader coverage.

## Job Sources

Job Hunter aggregates listings from multiple APIs. Each source is a pluggable adapter that normalizes results into a common format.

### Free Sources (No API Key Required)

| Source | Focus | Notes |
|--------|-------|-------|
| **[Remotive](https://remotive.com)** | Curated remote tech roles | High signal-to-noise ratio, quality listings |
| **[RemoteOK](https://remoteok.com)** | Remote jobs (all industries) | Largest remote job volume, includes salary data |
| **[Himalayas](https://himalayas.app)** | Remote-focused tech | Good salary disclosure rates |
| **[Jobicy](https://jobicy.com)** | Remote tech jobs | No auth needed, includes salary + currency |
| **[Arbeitnow](https://arbeitnow.com)** | EU + global remote | Visa sponsorship tagging |

### Paid/Authenticated Sources (Optional)

| Source | Cost | Why Use It |
|--------|------|-----------|
| **[JSearch](https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch)** (RapidAPI) | Free: 1K req/mo, Pro: $15/mo for 50K | Aggregates **Google for Jobs**, which scrapes LinkedIn, Indeed, Glassdoor, company career pages, and virtually every other job board. Dramatically increases coverage. |
| **[Adzuna](https://developer.adzuna.com)** | Free: 250 req/day | The **only API in the stack with server-side salary filtering**. When you set a $150K minimum, Adzuna filters at the API level instead of downloading everything. Also good international coverage. |

### How Sources Work Together

When you trigger a search (manually or via daily cron), the system:

1. Reads your active search configurations
2. Queries each enabled source in parallel with your keywords
3. Normalizes all results to a common schema (title, company, salary, location, tags, etc.)
4. Deduplicates by `source + sourceId`
5. Inserts only new jobs (skips duplicates already in the database)

You can enable/disable sources per search config from the Settings page.

### Adding a New Job Source

Create a new adapter in `server/utils/job-sources/`:

```typescript
// server/utils/job-sources/my-source.ts
import type { JobSourceAdapter, NormalizedJob, SearchParams } from './types'

export const mySourceAdapter: JobSourceAdapter = {
  name: 'my-source',

  async search(params: SearchParams): Promise<NormalizedJob[]> {
    // 1. Call the external API with params.keywords, params.locations, etc.
    // 2. Map the response to NormalizedJob[]
    // 3. Return the results
  },
}
```

Then register it in `server/api/jobs/search.post.ts` by adding it to the adapters map.

## Database

SQLite with Drizzle ORM. The database auto-creates and auto-migrates on first connection.

### Schema

| Table | Purpose |
|-------|---------|
| `jobs` | Discovered job listings with source, salary, description, match score, status |
| `applications` | Your applications - links to a job, stores tailored resume JSON, PDF path, cover letter, notes |
| `knowledge_entries` | Your profile data (skills, experience, preferences) - the AI's source of truth |
| `questions` | AI-generated questions to fill gaps in your knowledge base |
| `search_configs` | Saved search configurations (keywords, locations, sources, filters) |

### Management Commands

```bash
# Generate a new migration after schema changes
npm run db:generate

# Apply migrations
npm run db:migrate

# Seed the database with your resume data
npm run db:seed

# Open Drizzle Studio (visual database browser)
npm run db:studio
```

## Personalizing for Your Profile

### 1. Edit the Seed Script

The seed script at `server/db/seed.ts` populates your knowledge base. Edit it with your own data:

- **Profile**: Name, email, phone, GitHub, professional summary
- **Skills**: Your tech stack with descriptions of your experience level
- **Experience**: Work history with accomplishments and responsibilities
- **Education**: Degrees and certifications
- **Projects**: Notable side projects or products
- **Preferences**: Target salary, remote preference, industries of interest

### 2. Configure Search Settings

From the Settings page (`/settings`), create search configurations:

- **Keywords**: Job titles and terms to search for (e.g., "senior developer", "staff engineer")
- **Excluded keywords**: Filter out irrelevant results (e.g., "junior", "intern", ".NET")
- **Locations**: Where you want to work (e.g., "Remote", "United States")
- **Minimum salary**: Floor for salary filtering
- **Remote only**: Toggle to only find remote positions
- **Job sources**: Which APIs to query for this config

You can create multiple configs for different types of roles you're targeting.

### 3. Answer AI Questions

As the AI processes jobs, it may identify gaps in your knowledge base (e.g., "Do you have experience with GraphQL?"). These appear on the Questions page. Answering them improves future resume tailoring accuracy.

## Project Structure

```
job-hunter/
├── app/
│   ├── pages/                  # File-based routing
│   │   ├── index.vue           # Dashboard - stats, pipeline, recent activity
│   │   ├── jobs/
│   │   │   ├── index.vue       # Job feed with filters and match scores
│   │   │   └── [id].vue       # Job detail + resume generation
│   │   ├── applications/
│   │   │   ├── index.vue       # Application tracker (search by company)
│   │   │   └── [id].vue       # Interview prep - resume version, notes, timeline
│   │   ├── knowledge/
│   │   │   └── index.vue       # Knowledge base editor
│   │   ├── questions/
│   │   │   └── index.vue       # Daily question check-in
│   │   └── settings/
│   │       └── index.vue       # Search configs + manual actions
│   ├── components/             # Auto-imported Vue components
│   ├── composables/            # Shared state and API helpers
│   └── layouts/
│       └── default.vue         # App shell with sidebar navigation
├── server/
│   ├── api/                    # Nitro API routes
│   │   ├── jobs/               # CRUD + search + AI scoring
│   │   ├── applications/       # CRUD + resume generation trigger
│   │   ├── resume/             # AI tailoring + PDF download
│   │   ├── knowledge/          # Knowledge base CRUD
│   │   ├── questions/          # Question queue
│   │   ├── search-configs/     # Search configuration CRUD
│   │   └── stats.get.ts        # Dashboard statistics
│   ├── tasks/
│   │   └── jobs/
│   │       ├── search.ts       # Daily search cron (6 AM)
│   │       └── match.ts        # AI scoring cron (7 AM)
│   ├── utils/
│   │   ├── db.ts               # Drizzle + SQLite connection
│   │   ├── ai.ts               # Claude API client
│   │   ├── pdf.ts              # pdfmake resume generator
│   │   └── job-sources/        # Pluggable job source adapters
│   │       ├── types.ts        # NormalizedJob, SearchParams interfaces
│   │       ├── jsearch.ts      # Google for Jobs via RapidAPI
│   │       ├── adzuna.ts       # Adzuna with salary filtering
│   │       ├── remotive.ts     # Remotive (free)
│   │       └── ...             # More adapters
│   └── db/
│       ├── schema.ts           # Drizzle ORM schema (5 tables)
│       ├── seed.ts             # Database seeder
│       └── migrations/         # Auto-generated SQL migrations
├── nuxt.config.ts              # App config, themes, cron schedules
├── Dockerfile                  # Multi-stage production build
├── docker-compose.yml          # Docker Compose with persistent volume
└── .env.example                # Environment variable template
```

## Daily Workflow

1. **Morning**: The cron job has already searched for new jobs (6 AM) and scored them (7 AM)
2. **Open the dashboard**: See how many new jobs were found, check pending questions
3. **Review the job feed**: Jobs are sorted by match score - focus on 70+ scores
4. **For good matches**: Click into the job detail, review the AI's match analysis
5. **Generate a tailored resume**: The AI reframes your experience for each specific job
6. **Preview and submit**: Review the tailored resume PDF, then apply on the company's site
7. **Track it**: The application moves through your pipeline (Draft > Ready > Submitted > ...)
8. **When they call back**: Search by company name to instantly pull up your exact resume version and notes

## AI Integration Details

### Job Matching

The AI scores each job 0-100 based on:
- Role level match (junior vs senior vs staff)
- Tech stack overlap with your skills
- Salary range alignment
- Remote/location fit
- Industry and domain relevance

Each score comes with reasoning, missing skills, and keyword overlap analysis.

### Resume Tailoring

The AI follows strict rules:
- **Never fabricates** experience or skills
- **Reframes** existing accomplishments to match JD language
- **Reorders** sections and bullets to prioritize relevance
- **Adds keywords** naturally from the job description
- Generates a structured JSON that gets rendered as a clean ATS-friendly PDF

### Question Generation

After tailoring a resume, if the AI notices gaps (e.g., the JD mentions GraphQL but your knowledge base doesn't address it), it generates specific questions:
- "Do you have experience with GraphQL? If so, describe a project where you used it."
- Your answers get added to the knowledge base, improving future tailoring.

## Deployment Options

### Docker (Recommended)

Works with any Docker host - Coolify, Railway, Render, DigitalOcean, a VPS, etc.

```bash
docker compose up -d
```

Key considerations:
- Mount a **persistent volume** for `/app/data` (contains the SQLite database and generated PDFs)
- Set environment variables for API keys
- Expose port 3000

### Node.js Direct

```bash
npm run build
node .output/server/index.mjs
```

Set `NUXT_DATABASE_PATH` to a location with write access.

### Coolify

1. Create a new application from this GitHub repo
2. Set build pack to "Dockerfile"
3. Set exposed port to 3000
4. Add environment variables in the Coolify dashboard
5. Add a persistent storage volume mounted at `/data`
6. Set `NUXT_DATABASE_PATH=/data/job-hunter.db`
7. Deploy

## Scheduled Tasks

The app uses Nitro's built-in cron scheduler:

| Schedule | Task | Description |
|----------|------|-------------|
| `0 6 * * *` (6 AM daily) | `jobs:search` | Queries all enabled job sources with active search configs |
| `0 7 * * *` (7 AM daily) | `jobs:match` | Scores up to 10 unscored jobs using Claude AI |

You can also trigger both manually from the Settings page.

## Contributing

### Adding a Job Source

1. Create an adapter file in `server/utils/job-sources/`
2. Implement the `JobSourceAdapter` interface (name + search method)
3. Register it in the search endpoint and settings page source list
4. The adapter should normalize results to `NormalizedJob` format

### Architecture Notes

- **Server-side only**: All API keys and AI calls happen on the server via Nitro routes
- **No external database**: SQLite keeps everything self-contained and portable
- **Auto-migration**: The database creates itself and applies migrations on first connection
- **Component naming**: Nuxt 4 auto-imports components with directory prefixes (e.g., `components/jobs/JobCard.vue` becomes `<JobsJobCard>`)

## License

MIT

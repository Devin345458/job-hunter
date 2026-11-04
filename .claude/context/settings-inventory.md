# Settings: before and after inventory (2026-11-04)

Every control and piece of information on the single `/settings` page, and the one sub page it lives on now. Pages: Pipeline `/settings/pipeline`, Claude usage `/settings/claude-usage`, Job search `/settings/job-search`, GitHub evidence `/settings/github-evidence`, Memory `/settings/memory`, API keys `/settings/api-keys`, and the phone list `/settings`.

## Page header

| Before | After |
|---|---|
| Title "Settings" | Phone list title "Settings"; the "Settings" eyebrow above every sub page title |
| Subtitle naming what the page does, ending "Active searches run every 3 hours..." | Replaced by the one line per page on the phone list and each sub page's subtitle. The schedule is in the Pipeline subtitle and the Search Configurations subtitle |

## Pipeline card

| Before | After |
|---|---|
| Card title "Pipeline" and subtitle "Runs every 3 hours... Start the whole run or any one step here." | Pipeline page title and subtitle |
| Amber line: Claude subscription pause | Claude usage |
| Amber line: this app's limit stopped work | Claude usage |
| "Claude subscription: est. $X of $15.00 today, $Y of $105.00 in the last 7 days" | Claude usage, Claude subscription card (the label became the card title) |
| Today bar with the background share mark, and today's call count | Claude usage |
| Last 7 days bar and its call count | Claude usage |
| Background share note | Claude usage |
| Daily limit field, 7-day limit field, Save limits | Claude usage |
| API key (or AI) budget line, meter, over budget sentence | Claude usage, API key card |
| Where it went table: column heads, phase groups, rows with the "Counts:" tooltip, the per application line | Claude usage, Where it went card (the first column head now reads "Stage") |
| Full run row with Run | Pipeline |
| Nine step rows: name, Uses Claude tag, detail, last run line, Run or Queued | Pipeline |
| Queue heading and help text | Pipeline (`#queue`) |
| Backlog line | Pipeline |
| "Nothing is in the queue." | Pipeline |
| Full run under way rows with Cancel the rest | Pipeline |
| Running items, per job counts, waiting items with Cancel | Pipeline |
| Interrupted, failed, and resumed items | Pipeline |
| Recent runs heading and Refresh | Pipeline (`#runs`) |
| Load error line | Pipeline; Claude usage shows the same line for its own load, since both read `/api/pipeline/runs` |
| Heartbeat line | Pipeline |
| Run log rows with their expanded detail | Pipeline |

## GitHub evidence card

| Before | After |
|---|---|
| Card title and subtitle | GitHub evidence page title and subtitle |
| Loading bar, load error, no token alert, list error alert, SSO alert | GitHub evidence, above both tabs |
| Tokens | Identities and tokens tab |
| Repos with your commits: status, notes, error, Find repos with my commits, Turn on every repo with your commits | Repos tab |
| Index status, Index now, Refresh repo list | Repos tab |
| Repos: hint, Show all repos, Write missing descriptions, owner panels, Turn on the repos with your commits, Turn all off, client code warning, Find a repo, repo rows with their switch, description and Edit, this app's repo topics, Show more | Repos tab (heading now "Repos by owner") |
| Commits that count as yours: emails, logins, Save, Cancel, Use the defaults, Emails that do not count yet with Add | Identities and tokens tab |
| Confirm dialog | GitHub evidence |

## Memory card

| Before | After |
|---|---|
| Card title and subtitle | Memory page title and subtitle |
| Status line (its label "Memory" now reads "Status"), state chip, last checked, Check now, the explanation, last lookup | Memory |

## Job sources card

| Before | After |
|---|---|
| Title, subtitle, Pull everything again, last search, one row per source | Job search |

## Search Configurations card

| Before | After |
|---|---|
| Title, subtitle, Add Config | Job search |
| Form: name, keywords, excluded keywords, locations, minimum salary, remote only, job sources, Cancel, Save or Update | Job search |
| Config rows: switch, Edit, Delete, keyword line, exclude, location, salary, remote, and source chips | Job search |
| Empty state | Job search |

## API Keys card

| Before | After |
|---|---|
| Title and subtitle | API keys page title and subtitle |
| Intro line, six rows of variables with Set or Not set and what each is for, the closing sentence | API keys (no longer inside an info alert) |

## Dropped on purpose

- The six tinted avatars on the card headers. Decoration only; the page header names each page.

## New

- The expandable Settings group in the sidebar, with Paused on Claude usage while Claude calls are stopped.
- The phone list at `/settings` with a status per page (none for GitHub evidence; see AGENTS.md).
- The back arrow in the phone app bar on every sub page.
- The two GitHub evidence tabs, kept in the URL as `?tab=identities`.

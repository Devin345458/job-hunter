# Design system: job-hunter

The restyle of 2026-11-04 (branch feature/design-restyle, not merged until Devin compares it with production) set this direction. Every page inherits it through the Vuetify theme in `nuxt.config.ts`, the SASS settings in `app/assets/scss/components.scss`, and `app/assets/scss/global.scss`. Hold to it; deviate only with a stated reason, recorded below. The 2026-11-01 direction (dispatch desk, slate, cobalt ink, Schibsted Grotesk) is superseded; its decisions that still hold stay in the table at the end.

## Direction

App style true-black-flat (design-taste-frontend `draw.mjs --app`, kind support, seed 815537509), chosen because Devin works through a queue for a few minutes a day on phone and desktop, one decision per card. One true black ground; elevation by lightness alone; color only on data and on what blocks.

- **Face:** the one data hue, sky `#4cb3f0` (theme color `score`), on the match score wherever it shows: the Review card's number and ledger bar, the queue rows, the Jobs score column, the job page ring, Applications rows. No status uses it, so "how well it fits" never reads as good or bad.
- **Signature:** the score ledger (skills x 60% + pay x 40% = score) on the Decide card, and the score ring (92% filled, in the score hue) as the app's mark in the sidebar and on Sign in.
- **One primary per screen,** made primary by inversion: white fill, black label. Links, focus rings and selected controls read in ink.
- **Amber only on what blocks an approval** and its count: the Questions badge (blocking count), "Blocks an approval" on a question card with a 3px amber left edge, Needs you counts, Answer first, pause and limit lines.

## Banned (from the brief, enforced in the theme)

- Cream or off-white backgrounds, violet, indigo, terracotta. The light theme, unused today, is pure white.
- Italic accent words in headings.
- Numbered "01 / 02 / 03" section labels.
- Monospace labels. Inline `code` renders in the UI face. Only terminal output keeps a fixed-width face.
- Pill buttons. Every button and chip corner is 8px or less (`$rounded.pill` is 8px). The dealt style's primary is a white 36px pill; the pill shape is dropped, the inversion kept.
- Tracked uppercase labels, hairlines after section labels, a status pill above a heading, icons in tinted squares, gradients, shadows on anything at rest.

## Tokens

All colors live in the Vuetify theme. SCSS reads them as `rgb(var(--v-theme-*))`; no hex or rgba literal in component styles.

| Token | Value | Use |
|---|---|---|
| `background` | `#000000` | Page, drawer, app bar |
| `surface` | `#111111` | Cards, decision bar, list containers |
| `surface-bright` | `#222222` | Nested panels inside a card, the active row fill, hover |
| `surface-light` | `#2a2a2a` | Meter tracks, neutral tags, disabled button fill |
| `sunken` | `#080808` | Documents read inline: resume, letter, posting, logs |
| `primary` | `#ffffff`, text `#000000` | The one primary action (inversion), focus ring, selected controls |
| `score` | `#4cb3f0` | The match score, everywhere; nothing else |
| `secondary`, `accent`, `info` | `#b4b4b4`, `#b4b4b4`, `#c8c8c8` | Neutral: running, preparing, notices are not signals |
| `success` | `#3fc07a` | Submitted, heard back, learned plus points |
| `warning` | `#e5a93b` | Only what blocks an approval, and pauses |
| `error` | `#e5566f` | Failed, missing requirement mark, learned minus points |
| `border-color` / `border-opacity` | `#262626` / 1 | Row rules and control edges (solid; dividers forced to it in global.scss) |

Text: on-surface white at 0.96; medium emphasis 0.70 (`#b4b4b4` on black); disabled 0.5. Status pills are pale pairs: the hue on a 12 to 14% tint of itself; neutral states (primary, info, secondary) read as ink on `surface-light`.

## Type

Inter 400, 500, 600 (Google Fonts), the dealt face. Nothing above 600. `font-variant-numeric: tabular-nums` on `:root`, so every number lines up and money is one face everywhere.

- `h4` 24px/600, -0.015em (page titles, the one h1 per screen)
- `h5` 20px/600, `h6` 17px/600
- `subtitle-1` 16px/600, `subtitle-2` 14px/600
- `body-2` 14px/400, line height 1.5
- `caption` 12px; `overline` 12px/500 sentence case (no tracking)
- Buttons 14px/500, no uppercase, no tracking
- The answer figure (score ledger total) 36px/600 in the score hue

## Depth and spacing

- **Lightness only.** `v-card` outlined or flat has no border and no shadow; a card inside a card steps to `surface-bright`. Buttons, cards and sheets never cast a shadow (`box-shadow: none`).
- **Corners:** 16px cards and dialogs (`xl`), 10px nested panels, alerts and nav rows (`lg`), 8px controls (root), 6px chips.
- **Controls:** buttons 36px; fields compact (40px); every control 44px on a phone (global.scss).
- **Labels above fields** (`.field-label`, 14/500, 8px over the control) on forms; filter toolbars use placeholders with an aria-label.
- **Spacing:** 4px base. Card padding 16 to 24px desktop, 16px phone. Phone side gutter 16px.
- **Motion:** 150 to 220ms, `cubic-bezier(0.23, 1, 0.32, 1)`; nothing moves under `prefers-reduced-motion`.

## Component patterns

| Pattern | Measurements | Where |
|---|---|---|
| Page header | h1 24/600 and one 14px gray line about the data (a count, a schedule), or nothing; never a sentence on how the page works | `.page-header` in global.scss, every page |
| Shell nav | Active item by brightness: label and icon from medium emphasis to white at 600; no pill, tint or bar. Counts only on a queue that needs action (Review: to decide plus to send; Questions: blocking, amber) | `app/layouts/default.vue` |
| Health line | One 40px line above the queue: the state that matters most in its color (account problem, pause, limit, interrupted approval) else the last run, Runs and Queue links, opens the detail on click | `ReviewHealth.vue` (variant `line`) |
| Review card | No border; nested panels `surface-bright`; title h2 under the queue's h1, h1 on `/review/:id` (`titleTag`); state pill on the meta line under the title | `ReviewCard.vue` |
| Decision bar | Stage 1 reads "Nothing goes to <employer> until you approve it." with "What Apply does" opening the full sentence | `ReviewDecisionBar.vue` |
| Queue row | Score 17/600 in the score hue; the open row on `surface-bright` (no bar) | `ReviewQueueList.vue` |
| Jobs row | Columns score 48, role, state 148, base 156, total 156, figures right-aligned under one header; tablet four columns; phone two-line rows (score, title, total; state, company, base) | `JobRow.vue`, `pages/jobs/index.vue` |
| Underline tabs | 40px, 14/500, a 2px ink indicator on a full-width rule; only tabs with a count show; scroll sideways on a phone | `StatusPipeline.vue` |
| Key-value rows | Key column 160 to 260px, value, source and date; rules between rows on one card | `pages/knowledge/index.vue` |
| Question paging | Blocking first, "Next up" ten, the rest in groups by kind with counts, ten at a time, plus a find box | `pages/questions/index.vue` |
| Status tag | 12px/500, 1px 8px, 6px corners, the hue on a 12% fill (neutral states on `surface-light`) | `StatusTag.vue`, `ReviewCard.vue` |
| Missing value | A short 8x2px gray mark, never a dash at value size | `JobRow.vue` |
| Nav group (Settings) | Header row 44px: icon, title, chevron (an 8px warning square before it when folded and Claude usage is paused). Children text only, 13px/500, 32px tall on desktop and 44px in the phone drawer, 40px indent under a 1px rule at 17px; the active child white at 600, the rest medium emphasis | `app/layouts/default.vue` |
| Settings sub page header | h1 and one gray line from `settingsPages.ts` (or none); no "Settings" label above it | `app/components/settings/PageHeader.vue` |
| Settings list row (phone) | 72px minimum, 20px icon in medium emphasis, 15px/600 title with a status tag, 13px line, chevron | `app/pages/settings/index.vue` |
| Toast | Desktop bottom left, 280 to 340px wide, clear of the decision bar; phone top | `app/components/AppSnackbar.vue` |
| Phone sub page app bar | Back arrow to the list in place of the menu button, title is the sub page | `app/layouts/default.vue` |

## Decisions

| Date | Decision | Why |
|---|---|---|
| 2026-11-01 | Dark only, slate not indigo | Devin reviews early in the day on a phone; the old indigo and violet palette read as a generic AI dashboard |
| 2026-11-01 | One accent (cobalt ink) for the act of approving | Approve is irreversible and sends under his name; nothing else competes with it |
| 2026-11-01 | Approve is a plain primary button, no confirm dialog, no swipe | The brief: one tap, deliberate. The bar states the consequence instead of asking twice |
| 2026-11-01 | Queue is the home page; health is a small panel, not a stat-card row | The job is to decide, not to read metrics |
| 2026-11-01 | Toasts bottom left on desktop, top on phones | Bottom right covered the Approve button |
| 2026-11-04 | Settings is six pages, one per job: Pipeline (run, queue, log), Claude usage (spend and limits), Job search (searches and sources), GitHub evidence, Memory, API keys | The single page stacked six unrelated tools, and the spend table and limit fields sat above the Run buttons, so the page Devin opens most started with money. Each page now answers one question |
| 2026-11-04 | Spend, limits, and the amber pause lines moved off Pipeline to Claude usage | The fix for a pause is the limit field. Queue items keep their own "Paused" note, and the nav marks Claude usage Paused |
| 2026-11-04 | Desktop `/settings` goes straight to Pipeline; the phone gets a list of the pages | On desktop the sidebar group already is that list, so a list page would only cost a click. The phone has no lasting nav, so the list is the map. Pipeline is first because every link into Settings (Runs, Queue, View run) lands there |
| 2026-11-04 | The Settings group header only opens and closes | A header that also navigated would leave the page when he only wanted to see the sub pages; the group opens itself on any Settings route |
| 2026-11-04 | Sub pages in the sidebar are text only, indented under a rule | A second icon column made fourteen rows read as one flat list; the indent carries the hierarchy |
| 2026-11-04 | GitHub evidence: tabs Repos and Identities and tokens; this app's repo keeps its topics in its own row | The topics set what that one repo's switch counts, so they stay beside the switch. A third tab would split one decision across two places |
| 2026-11-04 | No tinted avatars on Settings card headers | Six avatars spent five semantic colors on decoration; the page header names the page and color stays for status |
| 2026-11-04 | Bottom bar's active item colored through `base-color` | Vuetify colors a link button only on its exact path, so every Settings sub page (and `/review/12`) left its button gray |
| 2026-11-04 | Restyle: true-black flat (dealt, seed 815537509) over the 2026-11-01 slate and cobalt | The slate read as the stock dark dashboard and blue sat on chrome (nav, links, pills, every button), so color said nothing. The study's darks are neutral |
| 2026-11-04 | One data hue (`score`, sky) on the match score everywhere | Review showed the score in blue and Jobs and the job page in green; the dealt lime is also the positive color, so a 45 would have read like a Submitted pill |
| 2026-11-04 | Primary by inversion, corners kept at 8px | The style's move; the pill shape it deals is banned by Devin's brief |
| 2026-11-04 | Inter replaces Schibsted Grotesk; tabular figures app wide | The dealt face; Schibsted's tabular comma took a digit-wide slot, which kept money out of tabular figures and mixed faces in Settings |
| 2026-11-04 | Kept the open-plane shell (no desktop top bar) | The dealt T-frame needs a top bar with something real in it; the app has no search or switcher, and the sheet flags an empty top bar. The redraw dealt No sidebar, which cannot hold eight destinations and the Settings group |
| 2026-11-04 | Health folds to one line above the queue | It held the top 390px of the queue column; the line keeps the paused or blocked state visible and the Runs and Queue links |
| 2026-11-04 | Jobs is a list with pay columns, not a card grid | Score, base and total could not be compared down a 3-up grid of 5 to 8 chips a card |
| 2026-11-04 | Questions page ten at a time | All 232 rendered on one 129-screen page |

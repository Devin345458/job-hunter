# Design system: job-hunter

The review dashboard set this direction on 2026-11-01. Every page inherits it through the Vuetify theme in `nuxt.config.ts` and the SASS settings in `app/assets/scss/components.scss`. Hold to it; deviate only with a stated reason, recorded below.

## Direction

A dispatch desk before dawn. Devin opens the app on his phone or laptop for five minutes a day, decides on applications that go out under his real name, and leaves. The interface is dark slate, quiet, and dense enough to scan, with one cobalt "ink" accent reserved for the act of signing off.

- **Focal point on every review card:** the decision. The match score (44px, 700) and the Approve button are the two loudest things on screen.
- **Signature:** the score ledger (the score itemized like a receipt, each learned adjustment its own line with its reason) and the floor line (total pay drawn on a scale with Devin's salary floor as a vertical rule).

## Banned (from the brief, enforced in the theme)

- Cream or off-white backgrounds. The light theme, unused today, is pure white.
- Italic accent words in headings.
- Numbered "01 / 02 / 03" section labels.
- Monospace labels. Inline `code` renders in the UI face. Only terminal output (test output, stack traces) keeps a fixed-width face.
- Pill buttons. Every button and chip corner is 8px or less, including Vuetify defaults: `$rounded.pill` is 8px, icon buttons are 8px, chips are 6px.

## Tokens

All colors live in the Vuetify theme. SCSS reads them as `rgb(var(--v-theme-*))`; no hex or rgba literal in component styles.

| Token | Value | Use |
|---|---|---|
| `background` | `#0f1318` | Page, drawer, app bar, inset panels on a card |
| `surface` | `#151a21` | Cards, decision bar |
| `surface-bright` | `#1c222b` | Raised surfaces |
| `sunken` | `#0b0e12` | Documents read inline: resume, letter, posting, README, logs |
| `primary` | `#6b93ff`, text `#08101f` | The one accent: approve, selection, links, focus ring |
| `success` | `#3fcf8e` | Submitted, clears floor, matched skills, positive learned points |
| `warning` | `#e9b04a` | Needs an answer, submit by hand |
| `error` | `#f2706f` | Submit failed, below floor, missing skills, negative learned points |
| `info` | `#79b4f2` | Sandbox marker, running |
| `border-color` / `border-opacity` | `#d0dae6` / 0.11 | Every hairline |

Contrast checked: primary on surface 6.5:1, dark text on primary 6.5:1, error on surface 6.0:1.

## Type

Schibsted Grotesk (Google Fonts, 400 to 800), a newsroom grotesk. 14px body on a 1.25 ratio, set in the `$typography` map:

- `h4` 28px/700, -0.02em (page titles)
- `h5` 22px/700, `h6` 18px/650
- `subtitle-1` 16px/600, `subtitle-2` 14px/600
- `body-2` 14px/400, line height 1.55
- `caption` 12px
- Buttons 14px/600, no uppercase, no tracking

Three emphasis levels through opacity: default 0.94, medium 0.66, disabled 0.4. Changing numbers in columns get `.tabular`; dollar amounts with decimals do not (the tabular period is wide in this face).

## Depth and spacing

- **Borders only.** No shadows; outlined variants are toned down to the border token (cards) or 38% of their color (buttons, chips).
- **Corners:** 6px controls, 8px chips, list rows, panels; 12px cards and dialogs.
- **Spacing:** 4px base. Card padding 20 to 24px desktop, 16px phone. Phone side gutter 16px.
- **Tap targets:** 44px minimum on every control at phone width (queue rows 56px, section headers 52px, decision buttons 48px).
- **Motion:** 150 to 220ms, `cubic-bezier(0.23, 1, 0.32, 1)`; nothing moves under `prefers-reduced-motion`.

## Component patterns

| Pattern | Measurements | Where |
|---|---|---|
| Review card | 12px radius, 1px border, header then blocking questions then verdict panels then collapsible sections, decision bar pinned to the bottom | `app/components/review/ReviewCard.vue` |
| Collapsible section | 52px header row: icon, 15px/600 title, one-line summary in medium emphasis (tinted for warning or error), chevron | `ReviewSection.vue` |
| Verdict panel | `background` fill inside the `surface` card, 8px radius, 16px padding | `ReviewCard.vue` |
| Decision bar | 48px buttons: outlined Reject (112px min), primary Approve (188px min); a line saying exactly what the tap sends; stacks on phones and sticks above the bottom nav | `ReviewDecisionBar.vue` |
| Status tag | 12px/600, 2px 8px padding, 6px radius, color at 12% fill | `ReviewCard.vue` |
| Queue row | 56px minimum, score 17px/700 right-aligned in 30px, title two-line clamp, 3px primary bar on the selected row | `ReviewQueueList.vue` |
| Quote from a posting | 2px primary rule on the left, 10px indent, 13px | `ReviewCompFloor.vue` |
| Status dot | 8px square, 2px radius | health strip, run log, ledger |
| Toast | Desktop bottom left, 280 to 340px wide, clear of the decision bar; phone top | `app/components/AppSnackbar.vue` |

## Decisions

| Date | Decision | Why |
|---|---|---|
| 2026-11-01 | Dark only, slate not indigo | Devin reviews early in the day on a phone; the old indigo and violet palette read as a generic AI dashboard |
| 2026-11-01 | One accent (cobalt ink) for the act of approving | Approve is irreversible and sends under his name; nothing else competes with it |
| 2026-11-01 | Approve is a plain primary button, no confirm dialog, no swipe | The brief: one tap, deliberate. The bar states the consequence instead of asking twice |
| 2026-11-01 | Queue is the home page; health is a small panel, not a stat-card row | The job is to decide, not to read metrics |
| 2026-11-01 | Toasts bottom left on desktop, top on phones | Bottom right covered the Approve button |

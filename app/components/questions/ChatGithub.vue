<script setup lang="ts">
import type { GithubChatSearch, GithubFinding } from '#shared/types/repos'

// "Found in your GitHub" under a chat reply that searched Devin's GitHub. Everything here comes
// from the server's search result, never from Claude's text: each finding links to GitHub in a new
// tab, a code search hit is labeled a lead, and the last lines say where the search looked and
// where to switch more repos on.
const props = defineProps<{ search: GithubChatSearch }>()

const KIND_LABEL: Record<GithubFinding['kind'], string> = {
  commit: 'Your commit',
  file: 'Lead',
  dependency: 'Package',
  language: 'Language',
}

const KIND_HINT: Record<GithubFinding['kind'], string> = {
  commit: 'opens your commit on GitHub',
  file: 'opens the file on GitHub',
  dependency: 'opens the manifest on GitHub',
  language: 'opens the repo on GitHub',
}

const findings = computed(() => props.search.findings)
const hasLeads = computed(() => findings.value.some(f => f.kind === 'file'))
const coverage = computed(() => props.search.coverage)

function monthYear(date: string) {
  const d = new Date(`${date}T12:00:00Z`)
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
}

function plural(n: number, one: string, many: string) {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
}

function meta(f: GithubFinding) {
  const parts = [f.repo]
  if (f.date) parts.push(monthYear(f.date))
  if (f.kind === 'commit' && f.detail) parts.push(f.detail === 'commit message' ? 'matched in the message' : `matched ${f.detail}`)
  if (f.kind === 'dependency' && f.detail) parts.push(`in ${f.detail}`)
  if (f.kind === 'file') {
    if (f.detail) parts.push(f.detail)
    parts.push('a repo with your commits')
  }
  return parts.join(', ')
}

/** Which repos the search covered, by name when nothing was found (that is when he needs them). */
const searchedText = computed(() => {
  const names = coverage.value.indexed
  const shown = names.length > 10 ? `${names.slice(0, 10).join(', ')}, and ${names.length - 10} more` : names.join(', ')
  const commits = names.length
    ? `your commits in ${plural(names.length, 'indexed repo', 'indexed repos')}${findings.value.length ? '' : ` (${shown})`}`
    : 'no indexed repos yet'
  const code = coverage.value.codeSearched.length ? ` and code in ${plural(coverage.value.codeSearched.length, 'repo', 'repos')}` : ''
  return `Searched ${commits}${code}.`
})

/** Why some repos were not searched. */
const missingText = computed(() => {
  const parts: string[] = []
  if (coverage.value.notIndexed) parts.push(`${plural(coverage.value.notIndexed, 'switched-on repo is', 'switched-on repos are')} not indexed yet`)
  if (coverage.value.offWithCommits) parts.push(`${plural(coverage.value.offWithCommits, 'repo with your commits is', 'repos with your commits are')} switched off`)
  if (!parts.length) return 'Only repos you switch on are searched.'
  return `${parts.join(', and ')}, so ${parts.length > 1 || coverage.value.notIndexed + coverage.value.offWithCommits > 1 ? 'they were' : 'it was'} not searched.`
})
</script>

<template>
  <section class="chat-github" aria-label="Found in your GitHub">
    <div class="chat-github__head">
      <v-icon icon="mdi-github" size="18" class="chat-github__icon" />
      <span class="chat-github__title">Found in your GitHub</span>
    </div>

    <ul v-if="findings.length" class="chat-github__list">
      <li v-for="f in findings" :key="`${f.kind}:${f.url}`">
        <a :href="f.url" target="_blank" rel="noopener noreferrer" class="chat-github__item">
          <span class="chat-github__row">
            <span class="chat-github__kind" :class="`chat-github__kind--${f.kind}`">{{ KIND_LABEL[f.kind] }}</span>
            <span class="chat-github__line">{{ f.title }}</span>
          </span>
          <span class="chat-github__meta">
            {{ meta(f) }}
            <v-icon icon="mdi-open-in-new" size="13" class="chat-github__out" aria-hidden="true" />
          </span>
          <span class="sr-only">({{ KIND_HINT[f.kind] }}, in a new tab)</span>
        </a>
      </li>
    </ul>
    <p v-else class="chat-github__none">
      Nothing found for {{ search.terms.slice(0, 6).join(', ') || 'what you asked' }}.
    </p>

    <p v-for="p in search.pathSummaries" :key="p.repo" class="chat-github__note">
      {{ plural(p.commits, 'of your commits', 'of your commits') }} in {{ p.repo }} change matching files, {{ monthYear(p.first) }} to {{ monthYear(p.last) }}.
    </p>
    <p v-if="hasLeads" class="chat-github__note">
      A lead is a file in a repo that holds your commits. Someone else may have written it, so open it before you count it.
    </p>
    <p class="chat-github__note chat-github__coverage">
      {{ searchedText }} {{ missingText }}
      <template v-if="coverage.codeNote"> {{ coverage.codeNote }}</template>
      <NuxtLink to="/settings#github-evidence" class="chat-github__settings">Settings, GitHub evidence</NuxtLink>
    </p>
  </section>
</template>

<style scoped lang="scss">
.chat-github {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgb(var(--v-theme-background));

  &__head {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  &__icon {
    color: rgba(var(--v-theme-on-surface), var(--v-high-emphasis-opacity));
  }

  &__title {
    font-size: 0.875rem;
    font-weight: 600;
    line-height: 1.4;
  }

  &__list {
    list-style: none;
    margin: 6px 0 4px;
    padding: 0;
  }

  &__item {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 2px;
    min-height: 44px;
    padding: 6px 0;
    text-decoration: none;
    color: inherit;
    border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    overflow-wrap: anywhere;

    &:hover .chat-github__line,
    &:focus-visible .chat-github__line {
      text-decoration: underline;
    }

    &:focus-visible {
      outline: 2px solid rgb(var(--v-theme-primary));
      outline-offset: 2px;
      border-radius: 4px;
    }
  }

  &__row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }

  &__kind {
    flex: 0 0 auto;
    font-size: 0.6875rem;
    font-weight: 600;
    line-height: 1.5;
    padding: 0 6px;
    border-radius: 4px;
    white-space: nowrap;

    &--commit {
      color: rgb(var(--v-theme-success));
      background: rgba(var(--v-theme-success), 0.12);
    }

    &--file {
      color: rgb(var(--v-theme-warning));
      background: rgba(var(--v-theme-warning), 0.14);
    }

    &--dependency,
    &--language {
      color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
      background: rgba(var(--v-theme-on-surface), 0.08);
    }
  }

  &__line {
    min-width: 0;
    font-size: 0.875rem;
    line-height: 1.4;
    color: rgb(var(--v-theme-primary));
  }

  &__meta {
    font-size: 0.75rem;
    line-height: 1.4;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__out {
    margin-left: 2px;
    vertical-align: -1px;
  }

  &__none {
    margin: 6px 0 4px;
    font-size: 0.875rem;
    line-height: 1.45;
  }

  &__note {
    margin: 6px 0 0;
    font-size: 0.8125rem;
    line-height: 1.45;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    text-wrap: pretty;
  }

  &__settings {
    display: inline-block;
    color: rgb(var(--v-theme-primary));
    font-weight: 500;
  }
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
</style>

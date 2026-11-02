<script setup lang="ts">
import type { RepoSuggestionView } from '#shared/types/repos'

// "Found in your GitHub" on a pending skill or experience question: the commits of Devin's own
// that suggest an answer, each linked to GitHub, and Use this, which picks the suggested level
// and puts the draft in the "Where did you do it?" box. Nothing is saved until Save. The parent
// decides what Use this does. This block only shows the evidence and asks.
const props = defineProps<{
  suggestion: RepoSuggestionView
  disabled?: boolean
  /** What the example box holds now, so Use this asks before replacing text Devin typed. */
  boxText?: string
}>()

const emit = defineEmits<{ use: [] }>()

const confirming = ref(false)

const typedOver = computed(() => {
  const t = (props.boxText ?? '').trim()
  return !!t && t !== props.suggestion.draft.trim()
})

function monthYear(date: string) {
  const d = new Date(`${date}T12:00:00Z`)
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })
}

function repoName(full: string) {
  return full.split('/')[1] ?? full
}

function use() {
  if (props.disabled) return
  if (typedOver.value && !confirming.value) {
    confirming.value = true
    return
  }
  confirming.value = false
  emit('use')
}

watch(() => props.boxText, () => {
  confirming.value = false
})
</script>

<template>
  <section class="repo-evidence" :aria-label="`Found in your GitHub: suggests ${suggestion.level}`">
    <div class="repo-evidence__head">
      <v-icon icon="mdi-github" size="18" class="repo-evidence__icon" />
      <span class="repo-evidence__title">Found in your GitHub</span>
      <span class="repo-evidence__level">Suggests {{ suggestion.level }}</span>
    </div>
    <p class="repo-evidence__hint">
      From commits you authored. Open them to check, then use the suggestion or answer your own way.
    </p>
    <ul class="repo-evidence__list">
      <li v-for="e in suggestion.evidence" :key="e.sha">
        <a :href="e.url" target="_blank" rel="noopener noreferrer" class="repo-evidence__item" :title="`${e.repo} commit ${e.sha.slice(0, 7)}`">
          <span class="repo-evidence__line">{{ e.line }}</span>
          <span class="repo-evidence__meta">
            {{ repoName(e.repo) }}, {{ monthYear(e.date) }}
            <v-icon icon="mdi-open-in-new" size="13" class="repo-evidence__out" aria-hidden="true" />
          </span>
          <span class="sr-only">(opens the commit on GitHub)</span>
        </a>
      </li>
    </ul>
    <div class="repo-evidence__actions">
      <v-btn
        :color="confirming ? 'warning' : 'primary'"
        variant="tonal"
        height="44"
        prepend-icon="mdi-text-box-check-outline"
        :disabled="disabled"
        class="repo-evidence__use"
        @click="use"
      >
        {{ confirming ? 'Replace what you typed' : 'Use this' }}
      </v-btn>
      <span class="repo-evidence__after">
        {{ confirming ? 'The example box has your own text. Tap again to replace it.' : `Picks ${suggestion.level} and fills the example box. Nothing is saved until Save.` }}
      </span>
    </div>
  </section>
</template>

<style scoped lang="scss">
.repo-evidence {
  margin-top: 12px;
  padding: 12px 14px;
  border-radius: 8px;
  border: 1px solid rgba(var(--v-theme-success), 0.3);
  background: rgba(var(--v-theme-success), 0.05);

  &__head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
  }

  &__icon {
    color: rgb(var(--v-theme-success));
  }

  &__title {
    font-size: 0.9375rem;
    font-weight: 600;
    line-height: 1.4;
  }

  &__level {
    font-size: 0.8125rem;
    font-weight: 600;
    padding: 1px 8px;
    border-radius: 6px;
    color: rgb(var(--v-theme-success));
    background: rgba(var(--v-theme-success), 0.12);
  }

  &__hint {
    margin: 4px 0 8px;
    font-size: 0.8125rem;
    line-height: 1.45;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    text-wrap: pretty;
  }

  &__list {
    list-style: none;
    margin: 0 0 10px;
    padding: 0;
  }

  &__item {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 1px;
    min-height: 44px;
    padding: 6px 0;
    text-decoration: none;
    color: inherit;
    border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    overflow-wrap: anywhere;

    &:hover .repo-evidence__line,
    &:focus-visible .repo-evidence__line {
      text-decoration: underline;
    }

    &:focus-visible {
      outline: 2px solid rgb(var(--v-theme-primary));
      outline-offset: 2px;
      border-radius: 4px;
    }
  }

  &__line {
    font-size: 0.875rem;
    line-height: 1.4;
    color: rgb(var(--v-theme-primary));
  }

  &__meta {
    font-size: 0.75rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__out {
    margin-left: 2px;
    vertical-align: -1px;
  }

  &__actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 12px;
  }

  &__use {
    text-transform: none;
    letter-spacing: normal;
  }

  &__after {
    flex: 1 1 220px;
    min-width: 0;
    font-size: 0.8125rem;
    line-height: 1.4;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
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

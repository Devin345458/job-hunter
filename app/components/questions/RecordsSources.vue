<script setup lang="ts">
import type { RecordsDraft, RecordSource } from '#shared/types/question-chat'

// The records under a draft from Devin's records: each sentence of the draft with the records it
// rests on (a knowledge base entry, one of his commits with its link, the counts across his commits,
// a past Claude session by date and project, or what he said in the chat). Shown in the chat and under the card's box, so he can
// check every sentence before he saves.

defineProps<{
  draft: RecordsDraft
  /** Why memory was left out of this draft, when it was. */
  memoryNote?: string | null
}>()

function icon(s: RecordSource) {
  switch (s.kind) {
    case 'knowledge': return 'mdi-database-outline'
    case 'commit': return 'mdi-source-commit'
    case 'memory': return 'mdi-history'
    case 'aggregate': return 'mdi-chart-bar'
    default: return 'mdi-format-quote-open'
  }
}

function sourceLine(s: RecordSource): string {
  if (s.kind === 'knowledge' || s.kind === 'aggregate') return s.label
  if (s.kind === 'commit') return `Commit in ${s.label}${s.date ? `, ${s.date}` : ''}`
  if (s.kind === 'memory') return `Claude session${s.date ? `, ${s.date}` : ''}${s.detail ? `, ${s.detail}` : ''}`
  return 'You said'
}
</script>

<template>
  <div class="records-sources">
    <p v-if="memoryNote" class="records-sources__note text-caption">
      <v-icon icon="mdi-laptop-off" size="14" />
      {{ memoryNote }}
    </p>
    <div class="records-sources__label text-caption text-medium-emphasis">Where each sentence comes from</div>
    <ol class="records-sources__list">
      <li v-for="(s, i) in draft.sentences" :key="i" class="records-sources__item">
        <div class="records-sources__sentence text-body-2">{{ s.text }}</div>
        <ul class="records-sources__refs">
          <li v-for="(src, j) in s.sources" :key="j" class="records-sources__ref text-caption">
            <v-icon :icon="icon(src)" size="14" class="records-sources__ref-icon" />
            <span class="records-sources__ref-text">
              <a v-if="src.url" :href="src.url" target="_blank" rel="noopener" class="records-sources__link">{{ sourceLine(src) }}</a>
              <span v-else>{{ sourceLine(src) }}</span>
              <span v-if="src.kind !== 'knowledge' && src.kind !== 'memory' && src.detail" class="text-medium-emphasis">: {{ src.detail }}</span>
            </span>
          </li>
        </ul>
      </li>
    </ol>
  </div>
</template>

<style scoped lang="scss">
.records-sources {
  margin-top: 10px;

  &__note {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    margin: 0 0 8px;
    padding: 6px 8px;
    border-radius: 6px;
    background: rgba(var(--v-theme-warning), 0.1);
    border: 1px solid rgba(var(--v-theme-warning), 0.3);

    .v-icon {
      margin-top: 1px;
      flex: 0 0 auto;
      color: rgb(var(--v-theme-warning));
    }
  }

  &__label {
    margin-bottom: 4px;
  }

  &__list {
    margin: 0;
    padding-left: 20px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  &__sentence {
    line-height: 1.45;
    overflow-wrap: anywhere;
  }

  &__refs {
    list-style: none;
    margin: 2px 0 0;
    padding: 0;
  }

  &__ref {
    display: flex;
    align-items: flex-start;
    gap: 4px;
    line-height: 1.4;
  }

  &__ref-icon {
    margin-top: 2px;
    flex: 0 0 auto;
    opacity: 0.7;
  }

  &__ref-text {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  &__link {
    color: rgb(var(--v-theme-primary));
  }
}
</style>

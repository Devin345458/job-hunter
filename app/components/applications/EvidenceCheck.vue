<script setup lang="ts">
// The evidence record stored in tailoring_notes: what the tailoring emphasized, then for the
// resume and the cover letter how many lines were checked against the knowledge base and
// exactly which lines were rewritten or dropped, and why.
import { plainEvidenceLine, plainKnowledgeRefs } from '#shared/utils/plain-text'

const props = defineProps<{ notes: string | null }>()

interface Check { title: string; summary: string; rewritten: string[]; dropped: string[] }

const parsed = computed(() => {
  // Knowledge base keys ("skill/Sentry") read as plain words ("your Sentry entry").
  const blocks = plainKnowledgeRefs(props.notes).split(/\n{2,}/).map(b => b.trim()).filter(Boolean)
  const checks: Check[] = []
  const notes: string[] = []
  const warnings: string[] = []
  for (const b of blocks) {
    const [first = '', ...rest] = b.split('\n')
    const m = first.match(/^(Resume evidence check|Cover letter evidence check): (.*)$/)
    if (m) {
      checks.push({
        title: m[1] === 'Resume evidence check' ? 'Resume' : 'Cover letter',
        summary: m[2]!,
        // Lines stored before the producer's wording fix read "X.; the rewrite was also unsupported (...))".
        rewritten: rest.filter(l => l.startsWith('Rewritten: ')).map(l => plainEvidenceLine(l.slice(11))),
        dropped: rest.filter(l => l.startsWith('Dropped: ')).map(l => plainEvidenceLine(l.slice(9))),
      })
    }
    else if (/^(Skills removed|Gap analysis failed)/.test(first)) warnings.push(b)
    else notes.push(b)
  }
  return { checks, notes, warnings }
})
</script>

<template>
  <div class="ev">
    <p v-if="!notes" class="ev__empty">No evidence record yet. It is written when the resume is tailored.</p>
    <template v-else>
      <div v-for="c in parsed.checks" :key="c.title" class="ev__check">
        <div class="ev__check-head">
          <v-icon :icon="c.dropped.length ? 'mdi-shield-alert-outline' : 'mdi-shield-check-outline'" size="18" :color="c.dropped.length ? 'warning' : 'success'" />
          <span class="ev__check-title">{{ c.title }}</span>
        </div>
        <p class="ev__summary">{{ c.summary }}</p>
        <ul v-if="c.rewritten.length || c.dropped.length" class="ev__list">
          <li v-for="(r, i) in c.rewritten" :key="`r${i}`" class="ev__item">
            <span class="ev__tag ev__tag--warning">Rewritten</span><span>{{ r }}</span>
          </li>
          <li v-for="(d, i) in c.dropped" :key="`d${i}`" class="ev__item">
            <span class="ev__tag ev__tag--error">Dropped</span><span>{{ d }}</span>
          </li>
        </ul>
      </div>
      <div v-for="(w, i) in parsed.warnings" :key="`w${i}`" class="ev__warning">{{ w }}</div>
      <div v-if="parsed.notes.length" class="ev__notes">
        <div class="ev__notes-title">What the tailoring emphasized</div>
        <p v-for="(n, i) in parsed.notes" :key="`n${i}`">{{ n }}</p>
      </div>
    </template>
  </div>
</template>

<style scoped lang="scss">
.ev {
  display: grid;
  gap: 12px;

  &__empty { margin: 0; font-size: 0.875rem; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }

  &__check {
    padding: 16px;
    border-radius: 8px;
    background: rgb(var(--v-theme-background));
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  }

  &__check-head { display: flex; align-items: center; gap: 8px; }
  &__check-title { font-size: 0.9375rem; font-weight: 600; }
  &__summary { margin: 6px 0 0; font-size: 0.875rem; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }

  &__list { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 10px; }

  &__item {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 10px;
    align-items: start;
    font-size: 0.8125rem;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }

  &__tag {
    font-size: 0.75rem;
    font-weight: 600;
    padding: 1px 8px;
    border-radius: 6px;

    &--warning { color: rgb(var(--v-theme-warning)); background: rgba(var(--v-theme-warning), 0.12); }
    &--error { color: rgb(var(--v-theme-error)); background: rgba(var(--v-theme-error), 0.12); }
  }

  &__warning {
    font-size: 0.8125rem;
    padding: 10px 12px;
    border-radius: 8px;
    color: rgb(var(--v-theme-warning));
    background: rgba(var(--v-theme-warning), 0.08);
    border: 1px solid rgba(var(--v-theme-warning), 0.3);
  }

  &__notes {
    font-size: 0.875rem;
    line-height: 1.6;

    p { margin: 6px 0 0; }
  }

  &__notes-title { font-size: 0.8125rem; font-weight: 700; }
}
</style>

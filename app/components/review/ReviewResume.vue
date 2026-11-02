<script setup lang="ts">
import type { TailoredResume } from '#shared/types/pipeline'

// The tailored resume, readable inline in the same order the PDF prints it.
defineProps<{
  resume: TailoredResume
  pdfUrl: string | null
}>()
</script>

<template>
  <div class="resume">
    <div class="resume__bar">
      <p v-if="resume.tailoringNotes" class="resume__notes">
        <v-icon icon="mdi-auto-fix" size="14" />
        {{ resume.tailoringNotes }}
      </p>
      <v-btn
        v-if="pdfUrl"
        :href="pdfUrl"
        target="_blank"
        rel="noopener"
        variant="tonal"
        prepend-icon="mdi-file-pdf-box"
        height="44"
      >
        Open PDF
      </v-btn>
    </div>

    <div class="resume__doc">
      <p v-if="resume.summary" class="resume__summary">{{ resume.summary }}</p>

      <h5 class="resume__h">Experience</h5>
      <div v-for="(e, i) in resume.experience" :key="i" class="resume__job">
        <div class="resume__job-head">
          <span class="resume__role">{{ e.title }}<template v-if="e.title && e.company">, </template>{{ e.company }}</span>
          <span class="resume__period">{{ e.period }}</span>
        </div>
        <ul class="resume__bullets">
          <li v-for="(b, j) in e.bullets" :key="j">{{ b }}</li>
        </ul>
      </div>

      <template v-if="resume.projects?.length">
        <h5 class="resume__h">Projects</h5>
        <div v-for="(p, i) in resume.projects" :key="i" class="resume__project">
          <span class="resume__role">{{ p.name }}</span>
          <span class="resume__desc">{{ p.description }}</span>
          <a v-if="p.url" :href="p.url" target="_blank" rel="noopener" class="resume__link">{{ p.url }}</a>
        </div>
      </template>

      <h5 class="resume__h">Skills</h5>
      <dl class="resume__skills">
        <div v-for="(list, group) in resume.skills" :key="group" class="resume__skill-row">
          <dt>{{ group }}</dt>
          <dd>{{ list.join(', ') }}</dd>
        </div>
      </dl>

      <template v-if="resume.education?.length">
        <h5 class="resume__h">Education</h5>
        <div v-for="(ed, i) in resume.education" :key="i" class="resume__edu">
          <span class="resume__role">{{ ed.institution }}</span>
          <span class="resume__desc">{{ [ed.degree, ed.year].filter(Boolean).join(', ') }}</span>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped lang="scss">
.resume {
  &__bar {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    margin-bottom: 12px;
  }

  &__notes {
    flex: 1 1 240px;
    margin: 0;
    font-size: 0.8125rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__doc {
    padding: 18px 20px;
    border-radius: 8px;
    background: rgb(var(--v-theme-sunken));
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    max-height: 520px;
    overflow-y: auto;
  }

  &__summary {
    margin: 0 0 6px;
    font-size: 0.875rem;
    line-height: 1.6;
  }

  &__h {
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    margin: 16px 0 8px;
    padding-bottom: 4px;
    border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__job {
    margin-bottom: 12px;
  }

  &__job-head {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }

  &__role {
    font-weight: 600;
    font-size: 0.875rem;
  }

  &__period {
    font-size: 0.8125rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__bullets {
    margin: 4px 0 0;
    padding-left: 18px;
    font-size: 0.8125rem;
    line-height: 1.55;

    li + li {
      margin-top: 3px;
    }
  }

  &__project,
  &__edu {
    display: flex;
    flex-direction: column;
    margin-bottom: 8px;
  }

  &__desc {
    font-size: 0.8125rem;
    color: rgba(var(--v-theme-on-surface), 0.82);
  }

  &__link {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    font-size: 0.8125rem;
    color: rgb(var(--v-theme-primary));
    word-break: break-all;
  }

  &__skills {
    margin: 0;
  }

  &__skill-row {
    display: grid;
    grid-template-columns: 120px 1fr;
    gap: 8px;
    font-size: 0.8125rem;
    padding: 2px 0;

    dt { font-weight: 600; }
    dd { margin: 0; }
  }
}

@media (max-width: 599.98px) {
  .resume__doc { padding: 14px; }
  .resume__skill-row { grid-template-columns: 1fr; gap: 0; padding: 4px 0; }
}
</style>

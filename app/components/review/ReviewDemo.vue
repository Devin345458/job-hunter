<script setup lang="ts">
import type { DemoProjectView, DemoStatus, ReviewItem } from '#shared/types/pipeline'
import { DEMO_STOP_TEXT, demoStopKind, plainError } from '#shared/utils/plain-text'

// The demo project built for this application. Approve publishes it (repo plus resume site)
// before the form is submitted, so its state is part of the decision.
const props = defineProps<{
  demo: DemoProjectView
  /** What approve will do (the review item's approveEffect); the built note says it. */
  effect?: ReviewItem['approveEffect'] | null
  /** Who a by-hand submit goes to. */
  company?: string
}>()

const STATUS: Record<DemoStatus, { label: string; color: string; note: string }> = {
  proposed: { label: 'Proposed', color: 'secondary', note: 'Not built yet.' },
  building: { label: 'Building', color: 'info', note: 'The build is running.' },
  built: { label: 'Built, not published', color: 'primary', note: 'Approve publishes it to GitHub and your resume site, then submits.' },
  failed: { label: 'Build failed', color: 'error', note: 'Approve will not publish a failed demo.' },
  publishing: { label: 'Publishing', color: 'info', note: 'Pushing the repo now.' },
  published: { label: 'Published', color: 'success', note: 'Live on GitHub.' },
  discarded: { label: 'Discarded', color: 'secondary', note: 'Not used.' },
}

/** Stopped on the Claude account (credit, key, budget), not on the build: said in the past tense, in a neutral color. */
const stop = computed(() => (props.demo.status === 'failed' ? demoStopKind(props.demo.error) : null))
const meta = computed(() => {
  if (stop.value) return { label: 'Stopped', color: 'secondary', note: `${DEMO_STOP_TEXT[stop.value].replace(/^Stopped: /, '').replace(/^\w/, c => c.toUpperCase())}. The build itself did not fail. Scheduled runs retry it automatically, ahead of new demos, one demo per run. Approve will not publish a demo that is not built.` }
  return STATUS[props.demo.status] ?? STATUS.proposed
})
/** A built demo's note says what approve does with it: blocked, publish then hand back, or publish then submit. */
const note = computed(() => {
  const e = props.effect
  if (props.demo.status !== 'built' || !e) return meta.value.note
  if (e.demoBlocked) return `${e.demoBlocked.replace(/\.$/, '')}, so approve stays off.`
  if (e.submit === 'manual') return `Approve publishes it to GitHub and your resume site, then marks the application for you to submit on ${props.company || 'the employer'}'s site.`
  return meta.value.note
})
const totalKb = computed(() => Math.round(props.demo.files.reduce((n, f) => n + f.bytes, 0) / 1024))
const readmeOpen = ref(false)
const outputOpen = ref(false)

function kb(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}
</script>

<template>
  <div class="demo">
    <div class="demo__head">
      <div class="demo__title-wrap">
        <div class="demo__title">{{ demo.title }}</div>
        <div class="demo__status" :class="`text-${meta.color}`">
          <span class="demo__dot" :class="`bg-${meta.color}`" />
          {{ meta.label }}
        </div>
      </div>
      <div class="demo__links">
        <v-btn v-if="demo.status === 'built' || demo.status === 'published'" :to="`/demos/${demo.id}#preview`" variant="tonal" prepend-icon="mdi-monitor-eye" height="44">Preview</v-btn>
        <v-btn v-if="demo.repoUrl" :href="demo.repoUrl" target="_blank" rel="noopener" variant="tonal" prepend-icon="mdi-github" height="44">Repo</v-btn>
        <v-btn v-if="demo.liveUrl" :href="demo.liveUrl" target="_blank" rel="noopener" variant="tonal" prepend-icon="mdi-open-in-new" height="44">Live</v-btn>
      </div>
    </div>
    <p class="demo__note">{{ note }}</p>

    <p v-if="demo.summary" class="demo__summary">{{ demo.summary }}</p>

    <dl class="demo__facts">
      <div v-if="demo.gapAddressed" class="demo__fact">
        <dt>Closes the gap</dt>
        <dd>{{ demo.gapAddressed }}</dd>
      </div>
      <div v-if="demo.techStack.length" class="demo__fact">
        <dt>Stack</dt>
        <dd class="demo__chips">
          <v-chip v-for="t in demo.techStack" :key="t" size="small" variant="tonal">{{ t }}</v-chip>
        </dd>
      </div>
      <div class="demo__fact">
        <dt>Tests</dt>
        <dd>
          <span v-if="demo.testsPassed === true" class="text-success demo__test"><v-icon icon="mdi-check-circle-outline" size="16" /> Passed</span>
          <span v-else-if="demo.testsPassed === false" class="text-error demo__test"><v-icon icon="mdi-close-circle-outline" size="16" /> Failed</span>
          <span v-else class="demo__muted">Not run</span>
          <span v-if="demo.testCommand" class="demo__muted"> with "{{ demo.testCommand }}"</span>
        </dd>
      </div>
      <div class="demo__fact">
        <dt>Files</dt>
        <dd>
          <span>{{ demo.files.length }} file{{ demo.files.length === 1 ? '' : 's' }}, {{ totalKb }} KB</span>
          <ul class="demo__files">
            <li v-for="f in demo.files" :key="f.path">
              <span class="demo__path">{{ f.path }}</span>
              <span class="demo__muted demo__size">{{ kb(f.bytes) }}</span>
            </li>
          </ul>
        </dd>
      </div>
    </dl>

    <div v-if="demo.error && !stop" class="demo__error" role="alert">
      <v-icon icon="mdi-alert-outline" size="16" />
      <span class="demo__error-text">{{ plainError(demo.error) }}</span>
    </div>

    <div class="demo__toggles">
      <v-btn v-if="demo.readme" variant="text" height="44" :prepend-icon="readmeOpen ? 'mdi-chevron-up' : 'mdi-chevron-down'" @click="readmeOpen = !readmeOpen">
        {{ readmeOpen ? 'Hide README' : 'Show README' }}
      </v-btn>
      <v-btn v-if="demo.testOutput" variant="text" height="44" :prepend-icon="outputOpen ? 'mdi-chevron-up' : 'mdi-chevron-down'" @click="outputOpen = !outputOpen">
        {{ outputOpen ? 'Hide test output' : 'Show test output' }}
      </v-btn>
    </div>
    <v-expand-transition>
      <div v-show="readmeOpen" class="demo__readme">
        <DemoReadme v-if="demo.readme" :source="demo.readme" />
      </div>
    </v-expand-transition>
    <v-expand-transition>
      <pre v-show="outputOpen" class="demo__output">{{ demo.testOutput }}</pre>
    </v-expand-transition>
  </div>
</template>

<style scoped lang="scss">
.demo {
  &__head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
    flex-wrap: wrap;
  }

  &__title {
    font-weight: 650;
    font-size: 1rem;
  }

  &__status {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.8125rem;
    font-weight: 600;
  }

  &__dot {
    width: 8px;
    height: 8px;
    border-radius: 2px;
  }

  &__links {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  &__note {
    font-size: 0.8125rem;
    margin: 4px 0 10px;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__summary {
    font-size: 0.875rem;
    margin: 0 0 10px;
  }

  &__facts {
    margin: 0;
  }

  &__fact {
    display: grid;
    grid-template-columns: 110px 1fr;
    gap: 12px;
    padding: 8px 0;
    border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    font-size: 0.875rem;

    dt {
      color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    }

    dd {
      margin: 0;
      min-width: 0;
    }
  }

  &__chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  &__test {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-weight: 600;
  }

  &__muted {
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__files {
    list-style: none;
    margin: 6px 0 0;
    padding: 0;
    font-size: 0.8125rem;

    li {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      padding: 2px 0;
    }
  }

  &__path {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  &__size {
    flex-shrink: 0;
    margin-left: 12px;
    white-space: nowrap;
  }

  &__error-text {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  &__error {
    display: flex;
    gap: 8px;
    align-items: flex-start;
    margin-top: 8px;
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 0.8125rem;
    color: rgb(var(--v-theme-error));
    background: rgba(var(--v-theme-error), 0.08);
  }

  &__toggles {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: 8px 0 0 -12px;
  }

  &__readme {
    font-size: 0.8125rem;
    overflow-wrap: anywhere;
    line-height: 1.6;
    padding: 14px 16px;
    border-radius: 8px;
    background: rgb(var(--v-theme-sunken));
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    margin-top: 8px;
  }

  // Test output is terminal output, so it keeps a fixed-width face to stay aligned.
  &__output {
    font-size: 0.75rem;
    line-height: 1.5;
    padding: 12px 14px;
    border-radius: 8px;
    background: rgb(var(--v-theme-sunken));
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    margin: 8px 0 0;
    overflow-x: auto;
    white-space: pre;
  }
}

@media (max-width: 599.98px) {
  .demo__fact {
    grid-template-columns: 1fr;
    gap: 2px;
  }
}
</style>

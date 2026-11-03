<script setup lang="ts">
import { useDisplay } from 'vuetify'
import type { DemoDetail, DemoTestCase } from '#shared/types/pipeline'
import { plainError } from '#shared/utils/plain-text'

// What the demo does, without publishing it. A web demo shows its static build in an iframe
// with sandbox="allow-scripts"; the server adds a CSP sandbox too, so the page gets an opaque
// origin: no cookies, no access to this app, no network. A demo without a UI lists its tests.
// Building either one runs the project's own tools on the server and never calls Claude.
const props = defineProps<{ demo: DemoDetail; busy?: boolean }>()
const emit = defineEmits<{ build: [] }>()

const { smAndDown } = useDisplay()
const frame = ref<'desktop' | 'phone'>('desktop')

const p = computed(() => props.demo.preview)
const building = computed(() => p.value.status === 'building')
const lastLine = computed(() => props.demo.progress?.waiting || props.demo.progress?.recent.at(-1)?.trim() || null)

const subtitle = computed(() => {
  if (p.value.kind === 'web') return 'The demo\'s own interface, built with Vite. It runs sandboxed: no cookies, no access to this app, no network.'
  return p.value.note
})

const STATUS: Record<DemoTestCase['status'], { icon: string; color: string; label: string }> = {
  passed: { icon: 'mdi-check-circle', color: 'success', label: 'Pass' },
  failed: { icon: 'mdi-close-circle', color: 'error', label: 'Fail' },
  skipped: { icon: 'mdi-minus-circle-outline', color: 'grey', label: 'Skipped' },
}

const counts = computed(() => {
  const tests = p.value.tests ?? []
  return {
    total: tests.length,
    passed: tests.filter(t => t.status === 'passed').length,
    failed: tests.filter(t => t.status === 'failed').length,
    skipped: tests.filter(t => t.status === 'skipped').length,
  }
})

const groups = computed(() => {
  const out: Array<{ suite: string | null; tests: DemoTestCase[] }> = []
  for (const t of p.value.tests ?? []) {
    const last = out[out.length - 1]
    if (last && last.suite === t.suite) last.tests.push(t)
    else out.push({ suite: t.suite, tests: [t] })
  }
  return out
})

const buildLabel = computed(() => {
  if (p.value.kind === 'tests') return p.value.status === 'missing' ? 'Run the tests' : 'Run the tests again'
  return p.value.status === 'missing' ? 'Build preview' : 'Build preview again'
})
</script>

<template>
  <section id="preview" class="demo-preview">
    <div class="demo-preview__head">
      <div class="demo-preview__intro">
        <h2 class="text-subtitle-1 font-weight-bold">
          Preview
        </h2>
        <p v-if="subtitle" class="text-body-2 text-medium-emphasis mb-0">
          {{ subtitle }}
        </p>
      </div>
      <div v-if="p.url && !building" class="demo-preview__tools">
        <v-btn-toggle v-if="!smAndDown" v-model="frame" mandatory divided variant="outlined" density="comfortable" aria-label="Preview width">
          <v-btn value="desktop" prepend-icon="mdi-monitor">
            Desktop
          </v-btn>
          <v-btn value="phone" prepend-icon="mdi-cellphone">
            Phone
          </v-btn>
        </v-btn-toggle>
        <v-btn :href="p.url" target="_blank" rel="noopener noreferrer" variant="tonal" height="44" prepend-icon="mdi-open-in-new">
          Open in a new tab
        </v-btn>
      </div>
    </div>

    <div v-if="building" class="demo-preview__building" role="status" aria-live="polite">
      <v-progress-circular indeterminate size="16" width="2" color="info" />
      <div>
        <div class="text-body-2 font-weight-medium">
          {{ p.kind === 'tests' ? `Running the tests with ${p.tool}` : 'Building the preview with Vite' }}
        </div>
        <div v-if="lastLine" class="text-caption text-medium-emphasis demo-preview__wrap">
          {{ lastLine }}
        </div>
      </div>
    </div>

    <template v-else-if="p.kind === 'web'">
      <div v-if="p.url" class="demo-preview__stage" :class="`demo-preview__stage--${smAndDown ? 'fluid' : frame}`">
        <iframe
          :key="p.builtAt ?? 'preview'"
          :src="p.url"
          :title="`Preview of ${demo.title}`"
          sandbox="allow-scripts"
          referrerpolicy="no-referrer"
          class="demo-preview__frame"
        />
      </div>
      <v-alert v-else-if="p.status === 'failed' && p.error" type="error" variant="tonal" density="compact" class="text-body-2 mb-3 demo-preview__wrap">
        {{ plainError(p.error) }}
      </v-alert>
      <p v-else class="text-body-2 mb-3">
        No preview yet. Building one runs the project's own Vite build on the server: no Claude, about a minute.
      </p>
    </template>

    <template v-else-if="p.kind === 'tests'">
      <v-alert v-if="p.status === 'failed' && p.error" type="error" variant="tonal" density="compact" class="text-body-2 mb-3 demo-preview__wrap">
        {{ plainError(p.error) }}
      </v-alert>
      <template v-else-if="p.tests?.length">
        <p class="text-body-2 mb-3">
          <span class="font-weight-medium">{{ counts.total }} tests with {{ p.tool }}:</span>
          {{ counts.passed }} passed<template v-if="counts.failed">, <span class="text-error">{{ counts.failed }} failed</span></template><template v-if="counts.skipped">, {{ counts.skipped }} skipped</template>.
        </p>
        <div class="demo-preview__tests">
          <div v-for="(g, gi) in groups" :key="gi" class="demo-preview__group">
            <div v-if="g.suite" class="demo-preview__suite text-body-2 font-weight-medium">
              <DemoPath :path="g.suite" />
            </div>
            <ul class="demo-preview__list">
              <li v-for="(t, ti) in g.tests" :key="ti" class="demo-preview__test">
                <v-icon :icon="STATUS[t.status].icon" :color="STATUS[t.status].color" size="18" class="demo-preview__test-icon" />
                <span class="demo-preview__test-name">{{ t.name }}</span>
                <span class="demo-preview__test-result text-caption" :class="`text-${STATUS[t.status].color}`">
                  {{ STATUS[t.status].label }}<template v-if="t.durationMs != null"><span class="text-medium-emphasis">, {{ t.durationMs }} ms</span></template>
                </span>
              </li>
            </ul>
          </div>
        </div>
      </template>
      <p v-else class="text-body-2 mb-3">
        The tests are not listed yet. Running them takes about a minute and does not use Claude.
      </p>
    </template>

    <div v-if="!building && p.kind !== 'none'" class="demo-preview__actions">
      <v-btn :variant="p.status === 'ready' ? 'text' : 'tonal'" height="44" :prepend-icon="p.kind === 'tests' ? 'mdi-test-tube' : 'mdi-hammer-wrench'" :loading="busy" @click="emit('build')">
        {{ buildLabel }}
      </v-btn>
      <span v-if="p.builtAt" class="text-caption text-medium-emphasis">
        Last {{ p.kind === 'tests' ? 'run' : 'built' }} {{ new Date(p.builtAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }}
      </span>
    </div>
  </section>
</template>

<style scoped lang="scss">
.demo-preview {
  scroll-margin-top: 80px;

  &__head {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px 16px;
    margin-bottom: 14px;
  }

  &__intro {
    min-width: 0;
    flex: 1 1 280px;
  }

  &__tools {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  &__building {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 12px 14px;
    margin-bottom: 12px;
    border-radius: 8px;
    background: rgba(var(--v-theme-info), 0.08);
    border: 1px solid rgba(var(--v-theme-info), 0.24);
  }

  &__wrap {
    overflow-wrap: anywhere;
  }

  &__stage {
    border-radius: 8px;
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    background: rgb(var(--v-theme-background));
    padding: 12px;
    margin-bottom: 12px;
    overflow: hidden;

    &--desktop .demo-preview__frame {
      width: 100%;
      height: 680px;
    }

    &--phone .demo-preview__frame {
      display: block;
      width: 390px;
      max-width: 100%;
      height: 760px;
      margin: 0 auto;
    }

    // Phones: the frame runs to the card's edges so the demo gets every pixel of width.
    &--fluid {
      padding: 0;
      margin-left: -16px;
      margin-right: -16px;
      border-radius: 0;
      border-left: 0;
      border-right: 0;

      .demo-preview__frame {
        width: 100%;
        height: 620px;
        border-radius: 0;
      }
    }
  }

  &__frame {
    display: block;
    border: 0;
    border-radius: 6px;
    background: rgb(var(--v-theme-surface));
  }

  &__tests {
    border-radius: 8px;
    border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    background: rgb(var(--v-theme-sunken));
    margin-bottom: 12px;
  }

  &__group + &__group {
    border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  }

  &__suite {
    padding: 10px 14px 2px;
  }

  &__list {
    list-style: none;
    margin: 0;
    padding: 4px 0 8px;
  }

  &__test {
    display: grid;
    grid-template-columns: 18px 1fr auto;
    gap: 10px;
    align-items: start;
    padding: 5px 14px;
    font-size: 0.875rem;
  }

  &__test-icon {
    margin-top: 2px;
  }

  &__test-name {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  &__test-result {
    white-space: nowrap;
    font-weight: 600;
    padding-top: 1px;
  }

  &__actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
  }
}

@media (max-width: 599.98px) {
  .demo-preview__test {
    grid-template-columns: 18px 1fr;

    .demo-preview__test-result {
      grid-column: 2;
      padding-top: 0;
    }
  }
}
</style>

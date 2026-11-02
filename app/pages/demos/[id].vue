<script setup lang="ts">
import type { DemoDetail } from '#shared/types/pipeline'
import { plainError } from '#shared/utils/plain-text'

definePageMeta({ layout: 'default' })

const route = useRoute()
const snackbar = useSnackbar()
const demoId = computed(() => Number(route.params.id))

const demo = ref<DemoDetail | null>(null)
const loading = ref(true)
const loadError = ref<string | null>(null)
const tab = ref('readme')

const selectedPath = ref<string | null>(null)
const fileContent = ref<{ path: string; content: string | null; binary: boolean; truncated: boolean } | null>(null)
const fileLoading = ref(false)

const discardOpen = ref(false)
const discarding = ref(false)

useHead(() => ({ title: demo.value ? `${demo.value.title} | Demo` : 'Demo project' }))

async function load() {
  loading.value = true
  loadError.value = null
  try {
    demo.value = await $fetch<DemoDetail>(`/api/demos/${demoId.value}`)
  }
  catch (e: any) {
    loadError.value = e?.data?.statusMessage || e?.message || 'Could not load this demo'
  }
  finally {
    loading.value = false
  }
}

async function openFile(path: string) {
  selectedPath.value = path
  fileLoading.value = true
  try {
    fileContent.value = await $fetch(`/api/demos/${demoId.value}/file`, { params: { path } })
  }
  catch (e: any) {
    fileContent.value = null
    snackbar.error(e?.data?.statusMessage || 'Could not open that file')
  }
  finally {
    fileLoading.value = false
  }
}

async function discard() {
  discarding.value = true
  try {
    demo.value = await $fetch<DemoDetail>(`/api/demos/${demoId.value}/discard`, { method: 'POST' })
    snackbar.success('Demo discarded and removed from the tailored resume')
    discardOpen.value = false
  }
  catch (e: any) {
    snackbar.error(e?.data?.statusMessage || 'Could not discard the demo')
  }
  finally {
    discarding.value = false
  }
}

const canDiscard = computed(() => demo.value && ['proposed', 'built', 'failed'].includes(demo.value.status))
const sortedFiles = computed(() => [...(demo.value?.files ?? [])].sort((a, b) => a.path.localeCompare(b.path)))

function formatBytes(n: number) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`
}

function formatDate(s: string | null) {
  if (!s) return null
  const d = new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`)
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

onMounted(load)
</script>

<template>
  <div class="demo-detail fade-in">
    <v-btn variant="text" prepend-icon="mdi-arrow-left" to="/demos" class="mb-4 demo-detail__back">
      All demos
    </v-btn>

    <v-alert v-if="loadError" type="error" variant="tonal" class="mb-4">
      {{ loadError }}
    </v-alert>
    <v-skeleton-loader v-if="loading" type="article, actions" />

    <template v-else-if="demo">
      <v-card variant="outlined" class="mb-5">
        <v-card-item>
          <template #prepend>
            <v-avatar color="secondary" variant="tonal" size="48" rounded="lg">
              <v-icon icon="mdi-flask-outline" />
            </v-avatar>
          </template>
          <v-card-title class="demo-detail__title text-h5">
            {{ demo.title }}
          </v-card-title>
          <v-card-subtitle class="demo-detail__subtitle">
            For {{ demo.job.title }} at {{ demo.job.company }}
          </v-card-subtitle>
        </v-card-item>

        <v-card-text>
          <div class="demo-detail__chips mb-4">
            <DemoStatusChip :status="demo.status" />
            <v-chip v-if="demo.isSandbox" size="small" variant="outlined" prepend-icon="mdi-test-tube">
              Sandbox application
            </v-chip>
            <v-chip
              v-if="demo.testsPassed !== null"
              size="small"
              variant="tonal"
              :color="demo.testsPassed ? 'success' : 'error'"
              :prepend-icon="demo.testsPassed ? 'mdi-check-circle' : 'mdi-close-circle'"
            >
              {{ demo.testsPassed ? 'Tests pass' : 'Tests fail' }}
            </v-chip>
          </div>

          <p v-if="demo.summary" class="demo-detail__summary text-body-1 mb-4">
            {{ demo.summary }}
          </p>

          <div v-if="demo.techStack.length" class="demo-detail__chips mb-5">
            <v-chip v-for="t in demo.techStack" :key="t" size="small" variant="outlined">
              {{ t }}
            </v-chip>
          </div>

          <dl class="demo-detail__facts">
            <div v-if="demo.gapAddressed" class="demo-detail__fact-wide">
              <dt>Shows</dt>
              <dd>{{ demo.gapAddressed }}</dd>
            </div>
            <div>
              <dt>Files</dt>
              <dd>{{ demo.files.length }}</dd>
            </div>
            <div>
              <dt>Build cost</dt>
              <dd>{{ demo.costUsd != null ? `$${demo.costUsd.toFixed(2)}` : 'n/a' }}</dd>
            </div>
            <div v-if="demo.builtAt">
              <dt>Built</dt>
              <dd>{{ formatDate(demo.builtAt) }}</dd>
            </div>
            <div v-if="demo.publishedAt">
              <dt>Published</dt>
              <dd>{{ formatDate(demo.publishedAt) }}</dd>
            </div>
          </dl>

          <v-alert v-if="demo.status === 'built'" type="info" variant="tonal" density="compact" class="mt-4 text-body-2" icon="mdi-lock-outline">
            Not published. Approving the application pushes it to {{ demo.plannedRepoUrl }} and adds a card to your resume site, then submits.
          </v-alert>
          <v-alert v-if="demo.status === 'published' && demo.repoUrl" type="success" variant="tonal" density="compact" class="mt-4 text-body-2 demo-detail__wrap">
            Published to {{ demo.repoUrl }}
          </v-alert>
          <v-alert v-if="demo.error" type="error" variant="tonal" density="compact" class="mt-4 text-body-2 demo-detail__wrap">
            {{ plainError(demo.error) }}
          </v-alert>
        </v-card-text>

        <v-card-actions class="px-4 pb-4 pt-0 demo-detail__actions">
          <v-btn v-if="demo.repoUrl && demo.repoUrl.startsWith('http')" variant="tonal" color="primary" :href="demo.repoUrl" target="_blank" prepend-icon="mdi-open-in-new">
            Repository
          </v-btn>
          <v-btn v-if="demo.applicationId" variant="text" :to="`/applications/${demo.applicationId}`" prepend-icon="mdi-file-document-outline">
            Application
          </v-btn>
          <v-spacer />
          <v-btn v-if="canDiscard" variant="text" color="error" prepend-icon="mdi-delete-outline" @click="discardOpen = true">
            Discard
          </v-btn>
        </v-card-actions>
      </v-card>

      <v-card v-if="demo.gap" variant="outlined" class="mb-5">
        <v-card-title class="text-subtitle-1 font-weight-bold pt-4 px-4">
          Gap analysis for this application
        </v-card-title>
        <v-card-text>
          <DemoGapAnalysis :gap="demo.gap" />
        </v-card-text>
      </v-card>

      <v-card variant="outlined">
        <v-tabs v-model="tab" color="primary" bg-color="surface" show-arrows>
          <v-tab value="readme" prepend-icon="mdi-book-open-outline">
            README
          </v-tab>
          <v-tab value="files" prepend-icon="mdi-file-tree-outline">
            Files
          </v-tab>
          <v-tab value="tests" prepend-icon="mdi-test-tube">
            Tests
          </v-tab>
          <v-tab value="log" prepend-icon="mdi-text-box-outline">
            Build log
          </v-tab>
        </v-tabs>
        <v-divider />
        <v-tabs-window v-model="tab">
          <v-tabs-window-item value="readme">
            <v-card-text class="pa-5">
              <DemoReadme v-if="demo.readme" :source="demo.readme" />
              <p v-else class="text-body-2 text-medium-emphasis">
                No README yet.
              </p>
            </v-card-text>
          </v-tabs-window-item>

          <v-tabs-window-item value="files">
            <v-card-text class="pa-0">
              <div class="demo-detail__files">
                <v-list density="compact" class="demo-detail__file-list" nav>
                  <v-list-item
                    v-for="f in sortedFiles"
                    :key="f.path"
                    :active="selectedPath === f.path"
                    color="primary"
                    rounded="lg"
                    @click="openFile(f.path)"
                  >
                    <v-list-item-title class="demo-detail__file-name">
                      {{ f.path }}
                    </v-list-item-title>
                    <template #append>
                      <span class="text-caption text-medium-emphasis ms-3 text-no-wrap">{{ formatBytes(f.bytes) }}</span>
                    </template>
                  </v-list-item>
                  <p v-if="!sortedFiles.length" class="text-body-2 text-medium-emphasis pa-4">
                    No files committed.
                  </p>
                </v-list>
                <div class="demo-detail__viewer">
                  <v-progress-linear v-if="fileLoading" indeterminate color="primary" />
                  <p v-if="!selectedPath" class="text-body-2 text-medium-emphasis pa-4">
                    Pick a file to read it.
                  </p>
                  <template v-else-if="fileContent">
                    <div class="demo-detail__viewer-head text-body-2 font-weight-medium">
                      {{ fileContent.path }}
                      <span v-if="fileContent.truncated" class="text-caption text-medium-emphasis"> (first 300 KB)</span>
                    </div>
                    <p v-if="fileContent.binary" class="text-body-2 text-medium-emphasis pa-4">
                      Binary file.
                    </p>
                    <pre v-else class="demo-detail__code">{{ fileContent.content }}</pre>
                  </template>
                </div>
              </div>
            </v-card-text>
          </v-tabs-window-item>

          <v-tabs-window-item value="tests">
            <v-card-text class="pa-5">
              <p class="text-body-2 mb-3">
                <span class="text-medium-emphasis">Command run by the build harness:</span>
                <code class="demo-detail__inline-code">{{ demo.testCommand || 'none' }}</code>
              </p>
              <pre v-if="demo.testOutput" class="demo-detail__code demo-detail__code--boxed">{{ demo.testOutput }}</pre>
              <p v-else class="text-body-2 text-medium-emphasis">
                No test run recorded.
              </p>
            </v-card-text>
          </v-tabs-window-item>

          <v-tabs-window-item value="log">
            <v-card-text class="pa-5">
              <pre v-if="demo.buildLog" class="demo-detail__code demo-detail__code--boxed">{{ demo.buildLog }}</pre>
              <p v-else class="text-body-2 text-medium-emphasis">
                No build log.
              </p>
            </v-card-text>
          </v-tabs-window-item>
        </v-tabs-window>
      </v-card>
    </template>

    <v-dialog v-model="discardOpen" max-width="440">
      <v-card>
        <v-card-title class="text-h6 pt-5 px-5">
          Discard this demo?
        </v-card-title>
        <v-card-text class="text-body-2 px-5">
          It comes off the tailored resume for this application and is never published. The files stay on the server.
        </v-card-text>
        <v-card-actions class="px-5 pb-4">
          <v-spacer />
          <v-btn variant="text" @click="discardOpen = false">
            Keep it
          </v-btn>
          <v-btn color="error" variant="tonal" :loading="discarding" @click="discard">
            Discard
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped lang="scss">
.demo-detail {
  max-width: 1100px;

  &__title {
    font-weight: 700;
    letter-spacing: -0.02em;
    white-space: normal;
    line-height: 1.25;
  }

  &__subtitle {
    white-space: normal;
  }

  &__chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  &__summary {
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    line-height: 1.65;
  }

  &__wrap {
    overflow-wrap: anywhere;
  }

  &__facts {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 14px 24px;
    margin: 0;

    dt {
      font-size: 0.8125rem;
      color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    }

    dd {
      margin: 2px 0 0;
      font-weight: 600;
      overflow-wrap: anywhere;
    }
  }

  &__fact-wide {
    grid-column: 1 / -1;
  }

  &__actions {
    flex-wrap: wrap;
    gap: 8px;
  }

  &__files {
    display: grid;
    grid-template-columns: minmax(220px, 300px) 1fr;
    min-height: 360px;

    @media (max-width: 760px) {
      grid-template-columns: 1fr;
    }
  }

  &__file-list {
    border-right: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    max-height: 640px;
    overflow-y: auto;

    @media (max-width: 760px) {
      border-right: 0;
      border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
      max-height: 280px;
    }
  }

  &__file-name {
    font-size: 0.875rem;
    overflow-wrap: anywhere;
    white-space: normal;
  }

  &__viewer {
    min-width: 0;
  }

  &__viewer-head {
    padding: 12px 16px;
    border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
    overflow-wrap: anywhere;
  }

  &__code {
    margin: 0;
    padding: 14px 16px;
    font-size: 0.8125rem;
    line-height: 1.55;
    overflow: auto;
    max-height: 640px;
    white-space: pre;

    &--boxed {
      border-radius: 8px;
      background: rgba(var(--v-theme-on-surface), 0.05);
      border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
  }

  &__inline-code {
    margin-left: 6px;
    padding: 2px 6px;
    border-radius: 4px;
    background: rgba(var(--v-theme-on-surface), 0.08);
    overflow-wrap: anywhere;
  }
}
</style>

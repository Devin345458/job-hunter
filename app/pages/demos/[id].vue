<script setup lang="ts">
import type { DemoDetail } from '#shared/types/pipeline'

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
const rebuilding = ref(false)
const previewing = ref(false)

useHead(() => ({ title: demo.value ? `${demo.value.title} | Demo` : 'Demo project' }))

/** A build or a preview build is running on the server, so the page refreshes itself. */
const active = computed(() => !!demo.value && (!!demo.value.progress || demo.value.preview.status === 'building'))
/** A build the server is running right now reads as building even before the row says so. */
const shownStatus = computed(() => demo.value?.progress ? 'building' as const : demo.value?.status ?? 'proposed')
const showPreview = computed(() => !!demo.value && (['built', 'publishing', 'published'].includes(demo.value.status) || demo.value.preview.status === 'building'))

async function load(quiet = false) {
  if (!quiet) loading.value = true
  loadError.value = null
  try {
    const wasBuilding = !!demo.value?.progress && demo.value.progress.phase === 'build'
    const wasPreviewing = demo.value?.preview.status === 'building'
    demo.value = await $fetch<DemoDetail>(`/api/demos/${demoId.value}`)
    if (wasBuilding && !demo.value.progress) {
      if (demo.value.status === 'built') snackbar.success('Built. Tests pass.')
      else snackbar.warning('The build stopped. The reason is at the top of the page.')
    }
    else if (wasPreviewing && demo.value.preview.status !== 'building' && !demo.value.progress) {
      if (demo.value.preview.status === 'ready') snackbar.success(demo.value.preview.kind === 'web' ? 'Preview ready' : 'Tests listed')
      else snackbar.error('The preview could not be built. The reason is in the Preview section.')
    }
  }
  catch (e: any) {
    if (!quiet) loadError.value = e?.data?.statusMessage || e?.message || 'Could not load this demo'
  }
  finally {
    loading.value = false
    schedule()
  }
}

let timer: ReturnType<typeof setTimeout> | null = null
function schedule() {
  if (timer) clearTimeout(timer)
  timer = active.value ? setTimeout(() => load(true), 3000) : null
}

async function rebuild() {
  rebuilding.value = true
  try {
    demo.value = await $fetch<DemoDetail>(`/api/demos/${demoId.value}/rebuild`, { method: 'POST' })
    snackbar.info('Building. This page updates as it runs.')
    schedule()
  }
  catch (e: any) {
    snackbar.error(e?.data?.statusMessage || 'Could not start the build')
  }
  finally {
    rebuilding.value = false
  }
}

async function buildPreview() {
  previewing.value = true
  try {
    demo.value = await $fetch<DemoDetail>(`/api/demos/${demoId.value}/preview`, { method: 'POST' })
    schedule()
  }
  catch (e: any) {
    snackbar.error(e?.data?.statusMessage || 'Could not start the preview')
  }
  finally {
    previewing.value = false
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

const canDiscard = computed(() => demo.value && !demo.value.progress && ['proposed', 'built', 'failed'].includes(demo.value.status))
const sortedFiles = computed(() => [...(demo.value?.files ?? [])].sort((a, b) => a.path.localeCompare(b.path)))

function formatBytes(n: number) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`
}

function formatDate(s: string | null) {
  if (!s) return null
  const d = new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`)
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

onMounted(async () => {
  await load()
  if (route.hash === '#preview') {
    await nextTick()
    document.getElementById('preview')?.scrollIntoView({ block: 'start' })
  }
})
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})
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
            <DemoStatusChip :status="shownStatus" />
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
            <template v-if="demo.approveEffect?.demoBlocked">
              Not published. {{ demo.approveEffect.demoBlocked }}, so approving its application stays off until it is set or this demo is discarded.
            </template>
            <template v-else-if="demo.approveEffect?.submit === 'manual'">
              Not published. Approving the application pushes it to {{ demo.plannedRepoUrl }} and adds a card to your resume site, then marks the application for you to submit on the employer's site.
            </template>
            <template v-else>
              Not published. Approving the application pushes it to {{ demo.plannedRepoUrl }} and adds a card to your resume site, then submits.
            </template>
          </v-alert>
          <v-alert v-if="demo.status === 'published' && demo.repoUrl" type="success" variant="tonal" density="compact" class="mt-4 text-body-2 demo-detail__wrap">
            Published to {{ demo.repoUrl }}
          </v-alert>
          <DemoBuildState :demo="demo" :busy="rebuilding" class="mt-4" @rebuild="rebuild" />
        </v-card-text>

        <v-card-actions class="px-4 pb-4 pt-0 demo-detail__actions">
          <v-btn v-if="demo.repoUrl && demo.repoUrl.startsWith('http')" variant="tonal" color="primary" height="44" :href="demo.repoUrl" target="_blank" prepend-icon="mdi-open-in-new">
            Repository
          </v-btn>
          <v-btn v-if="demo.applicationId" variant="text" height="44" :to="`/applications/${demo.applicationId}`" prepend-icon="mdi-file-document-outline">
            Application
          </v-btn>
          <v-spacer />
          <v-btn v-if="canDiscard" variant="text" color="error" height="44" prepend-icon="mdi-delete-outline" @click="discardOpen = true">
            Discard
          </v-btn>
        </v-card-actions>
      </v-card>

      <v-card v-if="showPreview" variant="outlined" class="mb-5">
        <v-card-text class="demo-detail__preview">
          <DemoPreview :demo="demo" :busy="previewing" @build="buildPreview" />
        </v-card-text>
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
                      <DemoPath :path="f.path" />
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
                      <DemoPath :path="fileContent.path" />
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
              <template v-if="demo.progress?.phase === 'build'">
                <p class="text-body-2 text-medium-emphasis mb-3">
                  Running now. The newest lines are below; the full log is saved when the build ends.
                </p>
                <pre class="demo-detail__code demo-detail__code--boxed mb-4">{{ demo.progress.recent.join('\n') || 'Starting...' }}</pre>
              </template>
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

  &__preview {
    padding: 20px 24px;

    @media (max-width: 599.98px) {
      padding: 16px;
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
    white-space: normal;
  }

  &__viewer {
    min-width: 0;
  }

  &__viewer-head {
    padding: 12px 16px;
    border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
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

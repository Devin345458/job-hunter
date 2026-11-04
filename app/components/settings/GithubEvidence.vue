<script setup lang="ts">
import type { AppRepoTopic, RepoOwnerGroup, RepoSettingsView, RepoView } from '#shared/types/repos'

// Settings > GitHub evidence (its own page since 2026-11-04). The repos the read tokens can see, grouped by owner, each with a
// switch: his own repos are on by default except forks, every organization's and other person's repo is off,
// and switching one of those on shows the client code warning. Below that, the commit identities
// that count as his. GET /api/repos never returns a token.

const snackbar = useSnackbar()
const route = useRoute()
const router = useRouter()
// Two tabs: Repos (find, index, switches) and Identities and tokens. The tab is in the URL
// (?tab=identities), so a link can open it; both stay mounted, so a half-typed identity list
// survives a tab switch. This app's repo keeps its topics in its own row, beside its switch.
const tab = computed<'repos' | 'identities'>({
  get: () => (route.query.tab === 'identities' ? 'identities' : 'repos'),
  set: (v) => { void router.replace({ query: { ...route.query, tab: v === 'repos' ? undefined : v } }) },
})
const data = ref<RepoSettingsView | null>(null)
const loading = ref(true)
const refreshing = ref(false)
const loadError = ref<string | null>(null)
const switching = ref<Record<string, boolean>>({})
const filters = reactive<Record<string, string>>({})
const shown = reactive<Record<string, number>>({})
const openPanels = ref<string[]>([])
const PAGE = 30

const CLIENT_WARNING = 'Client code. Claude reads short snippets of your commits in it, and only facts about what you built are stored. Turn on only if your agreements allow it.'

async function load(refresh = false) {
  loadError.value = null
  if (refresh) refreshing.value = true
  try {
    const first = !data.value
    data.value = await $fetch<RepoSettingsView>('/api/repos', { query: refresh ? { refresh: '1' } : {} })
    if (first) openPanels.value = data.value.groups.filter(g => g.personal).map(g => g.owner)
    // A poll while he is editing the identities must not throw his edits away.
    if (first || !idsChanged.value) resetIdentityDraft()
  }
  catch (e: any) {
    loadError.value = e?.data?.statusMessage || e?.message || 'Could not load the GitHub settings'
  }
  finally {
    loading.value = false
    refreshing.value = false
  }
}

const included = computed(() => (data.value?.groups ?? []).flatMap(g => g.repos.filter(r => r.included)))

function onCount(g: RepoOwnerGroup) {
  return g.repos.filter(r => r.included).length
}

// Once a search has run, the list shows only repos with his commits plus the ones he switched on,
// and hides owners left with none. "Show all repos" brings the rest back.
const showAll = ref(false)
const narrowed = computed(() => !!data.value?.find.at && !showAll.value)

function listedRepos(g: RepoOwnerGroup): RepoView[] {
  return narrowed.value ? g.repos.filter(r => (r.yourCommits ?? 0) > 0 || r.included) : g.repos
}

const shownGroups = computed(() => (data.value?.groups ?? []).filter(g => !narrowed.value || listedRepos(g).length > 0))
const hiddenCount = computed(() => {
  const all = (data.value?.groups ?? []).reduce((n, g) => n + g.repos.length, 0)
  const listed = (data.value?.groups ?? []).reduce((n, g) => n + listedRepos(g).length, 0)
  return all - listed
})

function visibleRepos(g: RepoOwnerGroup): RepoView[] {
  const f = (filters[g.owner] ?? '').trim().toLowerCase()
  const base = listedRepos(g)
  const list = f ? base.filter(r => r.name.toLowerCase().includes(f)) : base
  return list.slice(0, shown[g.owner] ?? PAGE)
}

function filteredCount(g: RepoOwnerGroup) {
  const f = (filters[g.owner] ?? '').trim().toLowerCase()
  const base = listedRepos(g)
  return f ? base.filter(r => r.name.toLowerCase().includes(f)).length : base.length
}

/** What the index line says about repos still waiting, given 30 a run. */
const indexWaiting = computed(() => {
  const i = data.value?.index
  if (!i) return ''
  const left = i.included - i.indexed - i.oversized - i.sso
  if (left <= 0) return ''
  if (left <= 30) return `The next run indexes the other ${left === 1 ? 'one' : left}.`
  return `Each run indexes 30, so the other ${left.toLocaleString('en-US')} take ${Math.ceil(left / 30)} more runs.`
})

function repoMeta(r: RepoView): string {
  const parts: string[] = []
  if (r.yourCommits != null) parts.push(r.yourCommits ? `${r.yourCommits.toLocaleString('en-US')} of your ${r.yourCommits === 1 ? 'commit' : 'commits'}` : 'none of your commits')
  if (r.isPrivate) parts.push('Private')
  if (r.archived) parts.push('Archived')
  if (r.sizeMb != null) parts.push(r.sizeMb >= 1 ? `${Math.round(r.sizeMb)} MB` : 'under 1 MB')
  if (r.included) {
    if (r.indexError) parts.push('last index failed')
    else if (r.skipReason) parts.push(r.skipReason)
    else if (r.indexedAt) parts.push(`${(r.commitCount ?? 0).toLocaleString('en-US')} indexed`)
    else parts.push('not indexed yet')
  }
  return parts.join(', ')
}

async function toggle(g: RepoOwnerGroup, r: RepoView, value: boolean | null) {
  const next = !!value
  const before = r.included
  r.included = next
  switching.value[r.fullName] = true
  try {
    await $fetch('/api/repos/include', { method: 'POST', body: { fullName: r.fullName, included: next } })
    if (!next) {
      r.indexedAt = null
      r.commitCount = null
    }
    snackbar.info(next
      ? `${r.name} is on. Its commits are read at the next index${r.appRepo ? ' and count only for its topics' : ''}.`
      : `${r.name} is off. Everything indexed from it was deleted.`)
  }
  catch (e: any) {
    r.included = before
    snackbar.notify(`${r.name} did not change: ${e?.data?.statusMessage || e?.message || 'unknown error'}`, 'error', { timeout: -1 })
  }
  finally {
    switching.value[r.fullName] = false
  }
}

// ── Topics this app's own repo counts for ──
// Its commits name every skill as data, so they count only for a subject that names one of these.
// "Up to Yes" topics can carry a Yes on their own; the others give Some experience at most.
const topicText = ref('')
const topicCap = ref<AppRepoTopic['cap']>('yes')
const savingTopics = ref(false)
const CAP_ITEMS = [
  { title: 'Up to Yes', value: 'yes' },
  { title: 'Up to Some experience', value: 'some' },
]
const topicGroups = computed(() => {
  const topics = data.value?.appRepo.topics ?? []
  return [
    { cap: 'yes' as const, label: 'Up to Yes', other: 'Up to Some experience', topics: topics.filter(t => t.cap === 'yes') },
    { cap: 'some' as const, label: 'Up to Some experience', other: 'Up to Yes', topics: topics.filter(t => t.cap === 'some') },
  ]
})

async function saveTopics(topics: AppRepoTopic[] | null, done: string) {
  if (!data.value) return
  savingTopics.value = true
  try {
    data.value.appRepo = await $fetch<RepoSettingsView['appRepo']>('/api/repos/app-topics', { method: 'PUT', body: topics ? { topics } : { reset: true } })
    snackbar.info(done)
    return true
  }
  catch (e: any) {
    snackbar.notify(`The topics did not save: ${e?.data?.statusMessage || e?.message || 'unknown error'}`, 'error', { timeout: -1 })
    return false
  }
  finally {
    savingTopics.value = false
  }
}

async function addTopic() {
  const name = topicText.value.replace(/\s+/g, ' ').trim()
  if (!name || !data.value) return
  const topics = data.value.appRepo.topics
  if (topics.some(t => t.name.toLowerCase() === name.toLowerCase())) {
    snackbar.info(`${name} is already a topic.`)
    return
  }
  if (await saveTopics([...topics, { name, cap: topicCap.value }], `Added ${name}. The next suggestion run uses it.`)) topicText.value = ''
}

function removeTopic(name: string) {
  if (!data.value) return
  saveTopics(data.value.appRepo.topics.filter(t => t.name !== name), `Removed ${name}.`)
}

function moveTopic(t: AppRepoTopic) {
  if (!data.value) return
  const cap = t.cap === 'yes' ? 'some' : 'yes'
  saveTopics(data.value.appRepo.topics.map(x => (x.name === t.name ? { ...x, cap } : x)), `${t.name} now counts ${cap === 'yes' ? 'up to Yes' : 'up to Some experience'}.`)
}

// ── What answers call each repo ──
// Answer text never names a client, repo, or organization; it uses this description instead.
const editingDesc = ref<string | null>(null)
const descText = ref('')
const savingDesc = ref(false)
const describing = ref(false)

function startDescription(r: RepoView) {
  editingDesc.value = r.fullName
  descText.value = r.description ?? ''
}

async function saveDescription(r: RepoView) {
  savingDesc.value = true
  try {
    const res = await $fetch<{ description: string | null; descriptionBy: RepoView['descriptionBy'] }>('/api/repos/description', { method: 'PUT', body: { fullName: r.fullName, text: descText.value } })
    r.description = res.description
    r.descriptionBy = res.descriptionBy
    editingDesc.value = null
    snackbar.info(res.description ? `Answers now call ${r.name} "${res.description}".` : `${r.name}'s description is cleared; a new one is written next time.`)
  }
  catch (e: any) {
    snackbar.notify(`The description did not save: ${e?.data?.statusMessage || e?.message || 'unknown error'}`, 'error', { timeout: -1 })
  }
  finally {
    savingDesc.value = false
  }
}

async function writeDescriptions() {
  describing.value = true
  try {
    const res = await $fetch<{ written: number; kept: number; failed: number }>('/api/repos/describe', { method: 'POST', body: {} })
    await load()
    snackbar.info(res.written
      ? `Wrote ${plural(res.written, 'description', 'descriptions')}.${res.failed ? ` ${plural(res.failed, 'repo', 'repos')} failed; try again.` : ''}`
      : res.failed ? `${plural(res.failed, 'repo', 'repos')} failed; try again.` : 'Every switched-on repo already has a description.')
  }
  catch (e: any) {
    snackbar.notify(`Descriptions were not written: ${e?.data?.statusMessage || e?.message || 'unknown error'}`, 'error', { timeout: -1 })
  }
  finally {
    describing.value = false
  }
}

// ── Bulk switches ──
const bulkBusy = ref<string | null>(null)
const confirm = ref<{ title: string; text: string; owners: string[]; action: string; run: () => Promise<void> } | null>(null)
const confirmOpen = computed({
  get: () => !!confirm.value,
  set: (v: boolean) => {
    if (!v) confirm.value = null
  },
})

function plural(n: number, one: string, many: string) {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
}

async function bulk(body: { owner?: string; included: boolean }, key: string) {
  bulkBusy.value = key
  try {
    const res = await $fetch<{ changed: number; owners: number }>('/api/repos/bulk', { method: 'POST', body })
    await load()
    snackbar.info(body.included
      ? `${plural(res.changed, 'repo', 'repos')} turned on. Their commits are read at the next index, 30 repos a run.`
      : `${plural(res.changed, 'repo', 'repos')} turned off. Everything indexed from them was deleted.`)
  }
  catch (e: any) {
    snackbar.notify(`Nothing changed: ${e?.data?.statusMessage || e?.message || 'unknown error'}`, 'error', { timeout: -1 })
  }
  finally {
    bulkBusy.value = null
  }
}

/** Turn on the repos with his commits: one owner's, or every owner's. The client code warning shows once first, unless every owner is his. */
function turnOnWithCommits(g?: RepoOwnerGroup) {
  if (!data.value) return
  const n = g ? (g.withCommitsOff ?? 0) : data.value.find.turnOn.repos
  const others = g ? (g.personal ? [] : [g.owner]) : data.value.find.turnOn.otherOwners
  const run = () => bulk({ ...(g ? { owner: g.owner } : {}), included: true }, g ? `on:${g.owner}` : 'on:all')
  if (!others.length) return run()
  confirm.value = {
    title: `Turn on ${plural(n, 'repo', 'repos')} with your commits?`,
    text: CLIENT_WARNING,
    owners: others,
    action: 'Turn on',
    run,
  }
}

function turnAllOff(g: RepoOwnerGroup) {
  const n = onCount(g)
  confirm.value = {
    title: `Turn off all ${plural(n, 'repo', 'repos')} in ${g.owner}?`,
    text: 'Everything indexed from them (commits, facts, the clones, and suggestions citing them) is deleted.',
    owners: [],
    action: 'Turn all off',
    run: () => bulk({ owner: g.owner, included: false }, `off:${g.owner}`),
  }
}

async function confirmRun() {
  const c = confirm.value
  confirm.value = null
  if (c) await c.run()
}

// ── Find repos with my commits ──
const finding = ref(false)

async function findRepos() {
  finding.value = true
  try {
    await $fetch('/api/repos/find', { method: 'POST' })
    snackbar.info('Searching GitHub for your commits. GitHub allows 30 searches a minute, so this takes a few minutes.')
    await pollFind()
  }
  catch (e: any) {
    snackbar.notify(`The search did not start: ${e?.data?.statusMessage || e?.message || 'unknown error'}`, 'error', { timeout: -1 })
  }
  finally {
    finding.value = false
  }
}

async function pollFind() {
  const until = Date.now() + 45 * 60_000
  do {
    await new Promise(r => setTimeout(r, 4000))
    await load()
  } while (data.value?.find.running && Date.now() < until)
  const f = data.value?.find
  if (!f || f.running) return
  if (f.error && (!f.at || (f.errorAt ?? '') > f.at)) snackbar.notify(`The search failed: ${f.error}`, 'error', { timeout: -1 })
  else snackbar.success(`Found ${plural(f.repos, 'repo', 'repos')} with your commits across ${plural(f.owners, 'owner', 'owners')}.`)
}

function duration(seconds: number | null) {
  if (seconds == null) return ''
  if (seconds < 90) return `${seconds} seconds`
  return `${Math.round(seconds / 60)} minutes`
}

// ── Identities ──
const emailsText = ref('')
const loginsText = ref('')
const savingIds = ref(false)

function resetIdentityDraft() {
  if (!data.value) return
  emailsText.value = data.value.identities.emails.join('\n')
  loginsText.value = data.value.identities.logins.join('\n')
}

const lines = (s: string) => s.split(/[\n,]+/).map(x => x.trim()).filter(Boolean)
const idsChanged = computed(() => !!data.value && (
  lines(emailsText.value).join('\n').toLowerCase() !== data.value.identities.emails.join('\n').toLowerCase()
  || lines(loginsText.value).join('\n').toLowerCase() !== data.value.identities.logins.join('\n').toLowerCase()))

async function saveIdentities(body: Record<string, unknown>, done: string) {
  savingIds.value = true
  try {
    await $fetch('/api/repos/identities', { method: 'PUT', body })
    snackbar.success(done)
    await load()
  }
  catch (e: any) {
    snackbar.notify(`Not saved: ${e?.data?.statusMessage || e?.message || 'unknown error'}`, 'error', { timeout: -1 })
  }
  finally {
    savingIds.value = false
  }
}

function saveIds() {
  saveIdentities({ emails: lines(emailsText.value), logins: lines(loginsText.value) }, 'Saved. The next index checks every commit against this list.')
}

function addEmail(email: string) {
  if (!data.value) return
  saveIdentities({ emails: [...data.value.identities.emails, email], logins: data.value.identities.logins }, `${email} now counts as yours from the next index.`)
}

// ── Index now ──
const indexing = ref(false)

async function indexNow() {
  indexing.value = true
  const before = data.value?.lastIndex?.id ?? 0
  try {
    await $fetch('/api/pipeline/run', { method: 'POST', body: { task: 'repos:index' } })
    snackbar.info('Indexing your commits. This page updates when it finishes.')
    const until = Date.now() + 15 * 60_000
    while (Date.now() < until) {
      await new Promise(r => setTimeout(r, 3000))
      await load()
      const last = data.value?.lastIndex
      if (last && last.id > before && last.status !== 'running') {
        if (last.status === 'succeeded') snackbar.success(`Indexed. ${data.value!.indexedCommits.toLocaleString('en-US')} of your commits are searchable.`)
        else snackbar.notify('The index run failed. Settings > Pipeline shows why.', 'error', { timeout: -1 })
        break
      }
    }
  }
  catch (e: any) {
    snackbar.notify(`The index did not start: ${e?.data?.statusMessage || e?.message || 'unknown error'}`, 'error', { timeout: -1 })
  }
  finally {
    indexing.value = false
  }
}

function when(t: string | null | undefined) {
  if (!t) return ''
  const d = new Date(`${t.replace(' ', 'T')}Z`)
  return Number.isNaN(d.getTime()) ? t : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function ownersText(owners: Array<{ owner: string; repos: number }>) {
  if (!owners.length) return 'no repos'
  const shownOwners = owners.slice(0, 6).map(o => `${o.owner} (${o.repos} ${o.repos === 1 ? 'repo' : 'repos'})`)
  return owners.length > 6 ? `${shownOwners.join(', ')}, and ${owners.length - 6} more owners` : shownOwners.join(', ')
}

function repoShort(full: string) {
  return full.split('/')[1] ?? full
}

onMounted(async () => {
  await load()
  if (data.value?.find.running) {
    finding.value = true
    await pollFind().finally(() => {
      finding.value = false
    })
  }
})
</script>

<template>
  <v-card variant="outlined" class="ghe">
    <!-- The page header carries the title and what GitHub evidence does; the tabs are this card's header. -->
    <v-tabs v-model="tab" color="primary" height="48" class="ghe__tabs" aria-label="GitHub evidence sections">
      <v-tab value="repos" class="ghe__tab">Repos</v-tab>
      <v-tab value="identities" class="ghe__tab">Identities and tokens</v-tab>
    </v-tabs>

    <v-card-text>
      <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-4" />
      <v-alert v-if="loadError" type="error" class="mb-4">{{ loadError }}</v-alert>

      <template v-if="data">
        <v-alert v-if="!data.configured" type="info" class="mb-4">
          No GitHub token is set on the server. Add <strong>NUXT_GITHUB_READ_TOKENS</strong>: either one classic token with the repo scope, which reads every repo you can reach in every organization, or fine-grained tokens with read access to Contents, Metadata, and Pull requests, separated by commas (a fine-grained token covers one owner).
        </v-alert>
        <v-alert v-if="data.listError" type="warning" class="mb-4">{{ data.listError }}</v-alert>
        <v-alert v-if="data.ssoOrgs.length" type="warning" class="mb-4" title="Some organizations need the token authorized">
          <ul class="ghe__sso">
            <li v-for="o in data.ssoOrgs" :key="o">Authorize this token for {{ o }} in GitHub (Configure SSO next to the token)</li>
          </ul>
          Until then, GitHub hides their repos and commits from it.
        </v-alert>

        <v-tabs-window v-model="tab" class="ghe__windows">
          <v-tabs-window-item value="repos" :transition="false" :reverse-transition="false">
            <!-- Find repos with my commits -->
            <section v-if="data.configured" class="ghe__block ghe__status" aria-labelledby="ghe-find" aria-live="polite">
              <div class="ghe__status-text">
                <h3 id="ghe-find" class="ghe__heading">Repos with your commits</h3>
                <template v-if="data.find.running && data.find.progress">
                  Searching GitHub: {{ plural(data.find.progress.commits, 'commit', 'commits') }} in {{ plural(data.find.progress.repos, 'repo', 'repos') }} so far.
                  <template v-if="data.find.progress.waitingSeconds">Waiting {{ data.find.progress.waitingSeconds }} seconds for GitHub's limit of 30 searches a minute.</template>
                </template>
                <template v-else-if="data.find.at">
                  {{ plural(data.find.commits, 'commit', 'commits') }} of yours in {{ plural(data.find.repos, 'repo', 'repos') }} across {{ plural(data.find.owners, 'owner', 'owners') }}, found {{ when(data.find.at) }} in {{ duration(data.find.seconds) }}. The daily run searches again once a day.
                </template>
                <template v-else>
                  Searches GitHub for every commit by your logins and emails, across every owner your tokens can read, and counts them per repo. Takes a few minutes.
                </template>
                <div v-for="n in data.find.notes" :key="n" class="ghe__muted">{{ n }}</div>
                <div v-if="data.find.error && !data.find.running" class="ghe__token-error">The last search failed: {{ data.find.error }}</div>
              </div>
              <div class="ghe__status-actions">
                <v-btn color="primary" variant="tonal" height="44" prepend-icon="mdi-source-commit" :loading="finding || data.find.running" @click="findRepos">
                  Find repos with my commits
                </v-btn>
              </div>
              <div v-if="data.find.at && !data.find.running" class="ghe__bulk-all">
                <v-btn
                  v-if="data.find.turnOn.repos"
                  color="success"
                  variant="flat"
                  height="44"
                  prepend-icon="mdi-toggle-switch"
                  :loading="bulkBusy === 'on:all'"
                  :disabled="!!bulkBusy"
                  @click="turnOnWithCommits()"
                >
                  Turn on every repo with your commits ({{ plural(data.find.turnOn.repos, 'repo', 'repos') }} across {{ plural(data.find.turnOn.owners, 'owner', 'owners') }})
                </v-btn>
                <span v-else-if="data.find.repos" class="ghe__muted">Every repo with your commits is on, except forks.</span>
              </div>
            </section>

            <!-- Index status -->
            <section v-if="data.configured" class="ghe__block ghe__status" aria-live="polite">
              <div class="ghe__status-text">
                <template v-if="data.index.included">
                  {{ data.index.indexed.toLocaleString('en-US') }} of {{ plural(data.index.included, 'repo', 'repos') }} indexed<template v-if="data.indexedCommits">, {{ plural(data.indexedCommits, 'commit', 'commits') }} of yours searchable</template>.
                  {{ indexWaiting }}
                  <template v-if="data.index.oversized">{{ plural(data.index.oversized, 'repo is', 'repos are') }} over 500 MB and never cloned.</template>
                  <template v-if="data.index.sso">{{ plural(data.index.sso, 'repo waits', 'repos wait') }} for SSO authorization.</template>
                </template>
                <template v-else>No repo is switched on yet, so nothing is indexed.</template>
                <template v-if="data.lastIndex">
                  Last index {{ when(data.lastIndex.startedAt) }}, {{ data.lastIndex.status }}.
                </template>
                The daily run indexes first and suggests answers last.
              </div>
              <div class="ghe__status-actions">
                <v-btn color="primary" variant="tonal" height="44" prepend-icon="mdi-database-sync-outline" :loading="indexing" :disabled="!included.length" @click="indexNow">
                  Index now
                </v-btn>
                <v-btn variant="text" height="44" prepend-icon="mdi-refresh" :loading="refreshing" @click="load(true)">
                  Refresh repo list
                </v-btn>
              </div>
            </section>

            <!-- Repos by owner -->
            <section v-if="data.groups.length" class="ghe__block" aria-labelledby="ghe-repos">
              <h3 id="ghe-repos" class="ghe__heading">Repos by owner</h3>
              <p class="ghe__hint">
                Your own repos are on by default. Forks and organization and client repos stay off until you turn them on. Turning on in bulk skips forks and repos without your commits. Turning a repo off deletes everything indexed from it.
              </p>
              <div class="ghe__narrow">
                <p v-if="!data.find.at" class="ghe__hint mb-0">Find repos with my commits to narrow this list.</p>
                <template v-else>
                  <p class="ghe__hint mb-0">
                    <template v-if="narrowed">Showing repos with your commits, most first, and any you switched on. {{ plural(hiddenCount, 'repo is', 'repos are') }} hidden.</template>
                    <template v-else>Showing every repo your tokens can read.</template>
                  </p>
                  <v-switch v-model="showAll" color="primary" hide-details inset density="compact" label="Show all repos" class="ghe__narrow-switch" />
                </template>
              </div>
              <div class="ghe__describe">
                <p class="ghe__hint mb-0">
                  Answers, letters, and resumes never name a client, repo, or organization. They describe the project instead, in the words under each switched-on repo. Correct any that are wrong.
                </p>
                <v-btn variant="tonal" height="40" class="ghe__describe-btn" prepend-icon="mdi-text-box-edit-outline" :loading="describing" @click="writeDescriptions">
                  Write missing descriptions
                </v-btn>
              </div>
              <v-expansion-panels v-model="openPanels" multiple variant="accordion" class="ghe__owners">
                <v-expansion-panel v-for="g in shownGroups" :key="g.owner" :value="g.owner" class="ghe__owner">
                  <v-expansion-panel-title class="ghe__owner-title">
                    <div class="ghe__owner-head">
                      <span class="ghe__owner-name">{{ g.owner }}</span>
                      <span class="ghe__owner-meta">
                        {{ g.personal ? 'Yours, on by default except forks' : g.ownerType === 'Organization' ? 'Organization, off by default' : 'Someone else\'s, off by default' }}.
                        {{ onCount(g) }} of {{ g.repos.length }} on.
                        <template v-if="g.withCommits != null">{{ g.withCommits ? `${plural(g.withCommits, 'has', 'have')} your commits.` : 'None have your commits.' }}</template>
                        <template v-if="g.sso"> Needs SSO authorization.</template>
                      </span>
                    </div>
                  </v-expansion-panel-title>
                  <v-expansion-panel-text>
                    <div v-if="(g.withCommitsOff ?? 0) > 0 || onCount(g) > 0" class="ghe__bulk">
                      <v-btn
                        v-if="(g.withCommitsOff ?? 0) > 0"
                        color="success"
                        variant="tonal"
                        height="44"
                        prepend-icon="mdi-toggle-switch"
                        :loading="bulkBusy === `on:${g.owner}`"
                        :disabled="!!bulkBusy"
                        @click="turnOnWithCommits(g)"
                      >
                        Turn on the {{ plural(g.withCommitsOff ?? 0, 'repo', 'repos') }} with your commits
                      </v-btn>
                      <v-btn
                        v-if="onCount(g) > 0"
                        variant="text"
                        height="44"
                        prepend-icon="mdi-toggle-switch-off-outline"
                        :loading="bulkBusy === `off:${g.owner}`"
                        :disabled="!!bulkBusy"
                        @click="turnAllOff(g)"
                      >
                        Turn all off
                      </v-btn>
                    </div>
                    <v-alert v-if="!g.personal && onCount(g) > 0" type="warning" density="compact" class="ghe__warning" role="note">
                      {{ CLIENT_WARNING }}
                    </v-alert>
                    <v-text-field
                      v-if="listedRepos(g).length > 12"
                      v-model="filters[g.owner]"
                      :label="`Find a repo in ${g.owner}`"
                      prepend-inner-icon="mdi-magnify"
                      clearable
                      hide-details
                      density="compact"
                      class="ghe__filter"
                    />
                    <ul class="ghe__repos">
                      <li v-for="r in visibleRepos(g)" :key="r.fullName" class="ghe__repo">
                        <div class="ghe__repo-row">
                          <div class="ghe__repo-text">
                            <!-- Name and details are one link, so the tap area is the full 44px row height. -->
                            <a v-if="r.htmlUrl" :href="r.htmlUrl" target="_blank" rel="noopener noreferrer" class="ghe__repo-link" :aria-label="`${r.name} on GitHub (opens a new tab)`">
                              <span class="ghe__repo-name">{{ r.name }}<span v-if="r.isFork" class="ghe__fork">Fork</span></span>
                              <span class="ghe__repo-meta">{{ repoMeta(r) }}</span>
                            </a>
                            <div v-else class="ghe__repo-link">
                              <span class="ghe__repo-name">{{ r.name }}<span v-if="r.isFork" class="ghe__fork">Fork</span></span>
                              <span class="ghe__repo-meta">{{ repoMeta(r) }}</span>
                            </div>
                            <span v-if="r.included && r.indexError" class="ghe__repo-error">{{ r.indexError }}</span>
                            <span v-if="r.note" class="ghe__repo-note">{{ r.note }}</span>
                            <div v-if="r.appRepo && data.appRepo" class="ghe__topics" role="group" :aria-label="`Topics ${r.name} counts for`">
                              <div v-for="grp in topicGroups" :key="grp.cap" class="ghe__topic-group">
                                <span class="ghe__topic-label">{{ grp.label }}</span>
                                <div class="ghe__topic-chips">
                                  <v-chip
                                    v-for="t in grp.topics"
                                    :key="t.name"
                                    size="small"
                                    variant="tonal"
                                    :color="grp.cap === 'yes' ? 'primary' : undefined"
                                    closable
                                    :disabled="savingTopics"
                                    :close-label="`Remove ${t.name}`"
                                    :aria-label="`${t.name}: move to ${grp.other}`"
                                    class="ghe__topic"
                                    @click="moveTopic(t)"
                                    @click:close="removeTopic(t.name)"
                                  >
                                    {{ t.name }}
                                  </v-chip>
                                  <span v-if="!grp.topics.length" class="ghe__muted">none</span>
                                </div>
                              </div>
                              <p class="ghe__topic-hint">Tap a topic to move it to the other level.<template v-if="data.appRepo.edited"> <button type="button" class="ghe__topic-reset" :disabled="savingTopics" @click="saveTopics(null, 'The starting topics are back.')">Put the starting topics back</button></template></p>
                              <form class="ghe__topic-add" @submit.prevent="addTopic">
                                <v-text-field
                                  v-model="topicText"
                                  label="Add a topic"
                                  placeholder="Model Context Protocol"
                                  maxlength="60"
                                  density="compact"
                                  hide-details
                                  class="ghe__topic-field"
                                />
                                <v-select
                                  v-model="topicCap"
                                  :items="CAP_ITEMS"
                                  label="Counts"
                                  density="compact"
                                  hide-details
                                  class="ghe__topic-cap"
                                />
                                <v-btn type="submit" color="primary" variant="tonal" height="40" :loading="savingTopics" :disabled="!topicText.trim()">Add</v-btn>
                              </form>
                            </div>
                            <form v-if="editingDesc === r.fullName" class="ghe__desc-edit" @submit.prevent="saveDescription(r)">
                              <v-text-field
                                v-model="descText"
                                :label="`What answers call ${r.name}`"
                                placeholder="car wash management software"
                                maxlength="120"
                                density="compact"
                                hide-details
                                autofocus
                                class="ghe__desc-field"
                              />
                              <v-btn type="submit" color="primary" variant="flat" height="40" :loading="savingDesc">Save</v-btn>
                              <v-btn variant="text" height="40" :disabled="savingDesc" @click="editingDesc = null">Cancel</v-btn>
                            </form>
                            <div v-else-if="r.included || r.description" class="ghe__desc">
                              <span class="ghe__desc-label">Answers call it:</span>
                              <span v-if="r.description" class="ghe__desc-text">{{ r.description }}<span v-if="r.descriptionBy === 'devin'" class="ghe__desc-by"> (yours)</span></span>
                              <span v-else class="ghe__desc-text ghe__desc-text--none">no description yet</span>
                              <v-btn variant="text" size="small" class="ghe__desc-btn" prepend-icon="mdi-pencil-outline" :aria-label="`Edit what answers call ${r.name}`" @click="startDescription(r)">Edit</v-btn>
                            </div>
                          </div>
                          <v-switch
                            :model-value="r.included"
                            color="success"
                            hide-details
                            inset
                            density="compact"
                            class="ghe__switch"
                            :loading="switching[r.fullName] ? 'success' : false"
                            :disabled="!!switching[r.fullName]"
                            :aria-label="`Use ${r.fullName} for GitHub evidence`"
                            @update:model-value="toggle(g, r, $event)"
                          />
                        </div>
                      </li>
                    </ul>
                    <p v-if="!filteredCount(g)" class="ghe__hint">No repo here matches.</p>
                    <v-btn
                      v-if="filteredCount(g) > (shown[g.owner] ?? PAGE)"
                      variant="text"
                      height="44"
                      class="ghe__more"
                      @click="shown[g.owner] = (shown[g.owner] ?? PAGE) + PAGE"
                    >
                      Show {{ Math.min(PAGE, filteredCount(g) - (shown[g.owner] ?? PAGE)) }} more of {{ filteredCount(g) }}
                    </v-btn>
                  </v-expansion-panel-text>
                </v-expansion-panel>
              </v-expansion-panels>
            </section>

          </v-tabs-window-item>

          <v-tabs-window-item value="identities" :transition="false" :reverse-transition="false">
            <!-- Tokens -->
            <section v-if="data.tokens.length" class="ghe__block" aria-labelledby="ghe-tokens">
              <h3 id="ghe-tokens" class="ghe__heading">Tokens</h3>
              <ul class="ghe__tokens">
                <li v-for="t in data.tokens" :key="t.position" class="ghe__token">
                  <div class="ghe__token-name">
                    Token {{ t.position }}<span class="ghe__muted">, from {{ t.source }}</span>
                  </div>
                  <div v-if="t.error" class="ghe__token-error">{{ t.error }}</div>
                  <div v-else class="ghe__token-text">
                    Signed in as {{ t.login }}. Reads {{ ownersText(t.owners) }}.
                    <template v-if="t.ssoOrgs.length"> GitHub left out {{ t.ssoOrgs.join(', ') }} until the token is authorized for SSO there.</template>
                  </div>
                </li>
              </ul>
            </section>

            <!-- Identities -->
            <section class="ghe__block" aria-labelledby="ghe-ids">
              <h3 id="ghe-ids" class="ghe__heading">Commits that count as yours</h3>
              <p class="ghe__hint">
                A commit counts when its author email is listed here, or when GitHub links it to one of these logins. Commits by anyone else in the same repo are never read.
                <template v-if="!data.identities.edited"> These start from your knowledge base email, your GitHub noreply addresses, and the token's login.</template>
              </p>
              <div class="ghe__ids">
                <v-textarea
                  v-model="emailsText"
                  label="Author emails, one per line"
                  rows="3"
                  auto-grow
                  autocomplete="off"
                  spellcheck="false"
                  wrap="off"
                  hide-details
                  class="ghe__ids-field"
                  :disabled="savingIds"
                />
                <v-textarea
                  v-model="loginsText"
                  label="GitHub logins, one per line"
                  rows="3"
                  auto-grow
                  autocomplete="off"
                  spellcheck="false"
                  wrap="off"
                  hide-details
                  class="ghe__ids-field"
                  :disabled="savingIds"
                />
              </div>
              <div class="ghe__ids-actions">
                <v-btn :color="idsChanged ? 'primary' : undefined" :variant="idsChanged ? 'flat' : 'tonal'" height="44" :disabled="!idsChanged" :loading="savingIds" @click="saveIds">
                  Save
                </v-btn>
                <v-btn v-if="idsChanged" variant="text" height="44" :disabled="savingIds" @click="resetIdentityDraft">Cancel</v-btn>
                <v-btn v-if="data.identities.edited && !idsChanged" variant="text" height="44" :disabled="savingIds" @click="saveIdentities({ reset: true }, 'Back to the defaults.')">
                  Use the defaults
                </v-btn>
              </div>

              <div v-if="data.unlistedEmails.length" class="ghe__unlisted">
                <div class="ghe__unlisted-title">Emails that do not count yet</div>
                <p class="ghe__hint mb-2">
                  These are on commits with your login as the author name, but GitHub links them to no account, so they could be anyone's. Add one only if it is yours.
                </p>
                <ul class="ghe__unlisted-list">
                  <li v-for="u in data.unlistedEmails" :key="u.email" class="ghe__unlisted-row">
                    <div class="ghe__unlisted-text">
                      <span class="ghe__unlisted-email">{{ u.email }}</span>
                      <span class="ghe__repo-meta">{{ u.commits }} {{ u.commits === 1 ? 'commit' : 'commits' }} in {{ u.repos.map(repoShort).join(', ') }}</span>
                    </div>
                    <v-btn variant="tonal" height="44" prepend-icon="mdi-plus" :disabled="savingIds" :aria-label="`Add ${u.email} as yours`" @click="addEmail(u.email)">
                      Add
                    </v-btn>
                  </li>
                </ul>
              </div>
            </section>
          </v-tabs-window-item>
        </v-tabs-window>
      </template>
    </v-card-text>

    <v-dialog v-model="confirmOpen" max-width="520">
      <v-card v-if="confirm" class="ghe__dialog">
        <v-card-title class="text-subtitle-1 font-weight-medium">{{ confirm.title }}</v-card-title>
        <v-card-text>
          <v-alert v-if="confirm.owners.length" type="warning" density="compact" class="mb-3">{{ confirm.text }}</v-alert>
          <p v-else class="mb-0">{{ confirm.text }}</p>
          <p v-if="confirm.owners.length" class="ghe__hint mb-0">
            Owners other than you in this: {{ confirm.owners.join(', ') }}.
          </p>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" height="44" @click="confirm = null">Cancel</v-btn>
          <v-btn :color="confirm.owners.length || confirm.action === 'Turn on' ? 'success' : 'error'" variant="flat" height="44" @click="confirmRun">{{ confirm.action }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-card>
</template>

<style scoped lang="scss">
.ghe__tabs {
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  padding: 0 8px;
}

.ghe__tab {
  font-size: 0.875rem;
  font-weight: 600;
  letter-spacing: normal;
  text-transform: none;
}

.ghe {
  scroll-margin-top: 72px;

  :deep(.v-card-subtitle),
  :deep(.v-card-title) {
    white-space: normal;
    line-height: 1.45;
  }

  &__block + &__block {
    margin-top: 20px;
    padding-top: 16px;
    border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  }

  &__heading {
    font-size: 0.9375rem;
    font-weight: 600;
    margin: 0 0 4px;
  }

  &__hint {
    font-size: 0.8125rem;
    line-height: 1.45;
    margin: 0 0 12px;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    text-wrap: pretty;
  }

  &__muted {
    font-weight: 400;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__tokens {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  &__token {
    padding: 6px 0;
    font-size: 0.875rem;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }

  &__token-name {
    font-weight: 600;
  }

  &__token-error {
    color: rgb(var(--v-theme-error));
  }

  &__status {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 16px;
  }

  &__status-text {
    flex: 1 1 320px;
    min-width: 0;
    font-size: 0.875rem;
    line-height: 1.45;
  }

  &__status-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;

    :deep(.v-btn) {
      text-transform: none;
      letter-spacing: normal;
    }
  }

  &__owners :deep(.v-expansion-panel-title) {
    min-height: 56px;
    padding: 10px 16px;
  }

  &__owner-head {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  &__owner-name {
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  &__owner-meta {
    font-size: 0.8125rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__filter {
    margin-bottom: 8px;
  }

  &__repos {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  &__repo {
    border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));

    &:first-child {
      border-top: 0;
    }
  }

  &__repo-row {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 56px;
    padding: 4px 0;
  }

  &__repo-text {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-width: 0;
  }

  &__repo-link {
    display: flex;
    flex-direction: column;
    justify-content: center;
    min-height: 44px;
    color: inherit;
    text-decoration: none;

    &:hover .ghe__repo-name,
    &:focus-visible .ghe__repo-name {
      text-decoration: underline;
    }

    &:focus-visible {
      outline: 2px solid rgb(var(--v-theme-primary));
      outline-offset: 2px;
      border-radius: 4px;
    }
  }

  &__repo-name {
    font-size: 0.875rem;
    font-weight: 500;
    color: rgb(var(--v-theme-on-surface));
    overflow-wrap: anywhere;
  }

  // Sits after the name. Forks are off by default, so the tag says why at a glance.
  &__fork {
    display: inline-block;
    margin-left: 8px;
    padding: 0 6px;
    border-radius: 6px;
    font-size: 0.6875rem;
    font-weight: 600;
    line-height: 1.6;
    vertical-align: 1px;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    background: rgba(var(--v-theme-on-surface), 0.08);
  }

  &__repo-meta {
    font-size: 0.75rem;
    line-height: 1.4;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    overflow-wrap: anywhere;
  }

  &__describe {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 16px;
    margin: 8px 0 12px;
  }

  &__describe-btn {
    text-transform: none;
    letter-spacing: normal;
  }

  &__desc {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0 6px;
    font-size: 0.8125rem;
    line-height: 1.4;
  }

  &__desc-label {
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__desc-text--none {
    font-style: italic;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__desc-by {
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__desc-btn {
    min-height: 32px;
    text-transform: none;
    letter-spacing: normal;
  }

  &__desc-edit {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin: 6px 0 4px;

    :deep(.v-btn) {
      text-transform: none;
      letter-spacing: normal;
    }
  }

  &__desc-field {
    flex: 1 1 260px;
    min-width: 0;
  }

  &__repo-error {
    font-size: 0.75rem;
    color: rgb(var(--v-theme-error));
    overflow-wrap: anywhere;
  }

  &__repo-note {
    font-size: 0.75rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
    overflow-wrap: anywhere;
  }

  &__topics {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 6px;
  }

  &__topic-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  &__topic-label {
    font-size: 0.75rem;
    font-weight: 600;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__topic-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  // A long topic wraps inside its chip, so the remove button never runs past the chip at 390.
  &__topic {
    max-width: 100%;
    height: auto !important;
    min-height: 32px;
    padding-top: 4px;
    padding-bottom: 4px;
    white-space: normal;

    :deep(.v-chip__content) {
      white-space: normal;
      overflow-wrap: anywhere;
    }
  }

  &__topic-hint {
    margin: 0;
    font-size: 0.75rem;
    color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
  }

  &__topic-reset {
    margin-left: 6px;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    color: rgb(var(--v-theme-primary));
    text-decoration: underline;
    cursor: pointer;
  }

  &__topic-add {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  &__topic-field {
    flex: 1 1 220px;
    min-width: 0;
  }

  &__topic-cap {
    flex: 0 1 220px;
    min-width: 180px;
  }

  // A 44px tap area around the switch, which Vuetify draws at 40px. The minimum width keeps a row
  // with wide content (the app repo's topic chips) from squeezing it out of line.
  &__switch {
    flex: 0 0 auto;
    min-width: 52px;

    :deep(.v-selection-control) {
      min-height: 48px;
    }

    :deep(.v-selection-control__wrapper),
    :deep(.v-selection-control__input) {
      min-width: 44px;
      min-height: 44px;
    }
  }

  &__warning {
    margin: 0 0 10px;
    font-size: 0.8125rem;
  }

  &__bulk,
  &__bulk-all {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 10px;

    :deep(.v-btn) {
      text-transform: none;
      letter-spacing: normal;
    }
  }

  &__bulk-all {
    flex: 1 1 100%;
    margin-bottom: 0;
  }

  &__narrow {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 4px 16px;
    margin-bottom: 12px;
  }

  &__narrow-switch {
    flex: 0 0 auto;

    :deep(.v-selection-control) {
      min-height: 44px;
    }
  }

  &__sso {
    margin: 4px 0 6px;
    padding-left: 18px;
  }

  &__dialog :deep(.v-btn) {
    text-transform: none;
    letter-spacing: normal;
  }

  &__more {
    margin-top: 4px;
    text-transform: none;
    letter-spacing: normal;
  }

  &__ids {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 12px;
  }

  // One identity per line: a long noreply address scrolls inside the box instead of wrapping into
  // what looks like a second entry.
  &__ids-field {
    min-width: 0;

    :deep(textarea) {
      white-space: pre;
      overflow-x: auto;
    }
  }

  &__ids-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 10px;

    :deep(.v-btn) {
      text-transform: none;
      letter-spacing: normal;
    }
  }

  &__unlisted {
    margin-top: 16px;
    padding: 12px 14px;
    border-radius: 8px;
    border: 1px solid rgba(var(--v-theme-warning), 0.35);
    background: rgba(var(--v-theme-warning), 0.05);
  }

  &__unlisted-title {
    font-weight: 600;
    font-size: 0.875rem;
    margin-bottom: 2px;
  }

  &__unlisted-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  &__unlisted-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    padding: 6px 0;
    border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));

    :deep(.v-btn) {
      text-transform: none;
      letter-spacing: normal;
    }
  }

  &__unlisted-text {
    display: flex;
    flex-direction: column;
    flex: 1 1 220px;
    min-width: 0;
  }

  &__unlisted-email {
    font-size: 0.875rem;
    overflow-wrap: anywhere;
  }
}
</style>

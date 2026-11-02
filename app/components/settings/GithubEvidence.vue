<script setup lang="ts">
import type { RepoOwnerGroup, RepoSettingsView, RepoView } from '#shared/types/repos'

// Settings > GitHub evidence. The repos the read tokens can see, grouped by owner, each with a
// switch: his own repos are on by default except forks, every organization's and other person's repo is off,
// and switching one of those on shows the client code warning. Below that, the commit identities
// that count as his. GET /api/repos never returns a token.

const snackbar = useSnackbar()
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
    resetIdentityDraft()
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

function visibleRepos(g: RepoOwnerGroup): RepoView[] {
  const f = (filters[g.owner] ?? '').trim().toLowerCase()
  const list = f ? g.repos.filter(r => r.name.toLowerCase().includes(f)) : g.repos
  return list.slice(0, shown[g.owner] ?? PAGE)
}

function filteredCount(g: RepoOwnerGroup) {
  const f = (filters[g.owner] ?? '').trim().toLowerCase()
  return f ? g.repos.filter(r => r.name.toLowerCase().includes(f)).length : g.repos.length
}

function repoMeta(r: RepoView): string {
  const parts: string[] = []
  if (r.isPrivate) parts.push('Private')
  if (r.archived) parts.push('Archived')
  if (r.sizeMb != null) parts.push(r.sizeMb >= 1 ? `${Math.round(r.sizeMb)} MB` : 'under 1 MB')
  if (r.included) {
    if (r.indexError) parts.push('last index failed')
    else if (r.skipReason) parts.push(r.skipReason)
    else if (r.indexedAt) parts.push(`${(r.commitCount ?? 0).toLocaleString('en-US')} of your commits indexed`)
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
      ? `${r.name} is on. Its commits are read at the next index.`
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

onMounted(() => load())
</script>

<template>
  <v-card variant="outlined" class="ghe">
    <v-card-item>
      <template #prepend>
        <v-avatar color="success" variant="tonal" size="36" rounded="lg">
          <v-icon icon="mdi-github" size="20" />
        </v-avatar>
      </template>
      <v-card-title class="text-subtitle-1 font-weight-medium">GitHub evidence</v-card-title>
      <v-card-subtitle>
        Suggests answers to skill and experience questions from commits you authored, with links. Code in a repo you can read is not code you wrote, so only your own commits count, and finding nothing never means No.
      </v-card-subtitle>
    </v-card-item>

    <v-card-text>
      <v-progress-linear v-if="loading" indeterminate color="primary" class="mb-4" />
      <v-alert v-if="loadError" type="error" class="mb-4">{{ loadError }}</v-alert>

      <template v-if="data">
        <v-alert v-if="!data.configured" type="info" class="mb-4">
          No GitHub token is set on the server. Add <strong>NUXT_GITHUB_READ_TOKENS</strong>: fine-grained tokens with read access to Contents, Metadata, and Pull requests, separated by commas. A fine-grained token covers one owner, so use one for your account and one for each organization.
        </v-alert>
        <v-alert v-if="data.listError" type="warning" class="mb-4">{{ data.listError }}</v-alert>

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
              </div>
            </li>
          </ul>
        </section>

        <!-- Index status -->
        <section v-if="data.configured" class="ghe__block ghe__status" aria-live="polite">
          <div class="ghe__status-text">
            <template v-if="data.indexedCommits">
              {{ data.indexedCommits.toLocaleString('en-US') }} of your commits indexed from {{ included.length }} {{ included.length === 1 ? 'repo' : 'repos' }}.
            </template>
            <template v-else>Nothing is indexed yet.</template>
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
          <h3 id="ghe-repos" class="ghe__heading">Repos</h3>
          <p class="ghe__hint">
            Your own repos are on by default. Forks and organization and client repos stay off until you turn them on. Turning a repo off deletes everything indexed from it.
          </p>
          <v-expansion-panels v-model="openPanels" multiple variant="accordion" class="ghe__owners">
            <v-expansion-panel v-for="g in data.groups" :key="g.owner" :value="g.owner" class="ghe__owner">
              <v-expansion-panel-title class="ghe__owner-title">
                <div class="ghe__owner-head">
                  <span class="ghe__owner-name">{{ g.owner }}</span>
                  <span class="ghe__owner-meta">
                    {{ g.personal ? 'Yours, on by default except forks' : g.ownerType === 'Organization' ? 'Organization, off by default' : 'Someone else\'s, off by default' }}.
                    {{ onCount(g) }} of {{ g.repos.length }} on.
                  </span>
                </div>
              </v-expansion-panel-title>
              <v-expansion-panel-text>
                <v-text-field
                  v-if="g.repos.length > 12"
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
                    <v-alert v-if="!g.personal && r.included" type="warning" density="compact" class="ghe__warning" role="note">
                      {{ CLIENT_WARNING }}
                    </v-alert>
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
      </template>
    </v-card-text>
  </v-card>
</template>

<style scoped lang="scss">
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

  &__repo-error {
    font-size: 0.75rem;
    color: rgb(var(--v-theme-error));
    overflow-wrap: anywhere;
  }

  // A 44px tap area around the switch, which Vuetify draws at 40px.
  &__switch {
    flex: 0 0 auto;

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

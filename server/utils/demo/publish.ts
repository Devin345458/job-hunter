import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readCardFacts } from './build'
import { git } from './exec'
import { insertCaseCard, SANDBOX_RESUME_FIXTURE, type ResumeCard } from './resume-site'
import { appendBuildLog, getAppWithJob, getDemo, githubRepoUrl, updateDemo, type DemoRow } from './store'

// Owned by capability B (demo projects). Pushes a built demo to its public repo and adds a
// card for it to the resume site. Only the approval orchestrator (runApproval) calls it, and
// only after Devin's approve click.
//
// Real applications: GitHub REST API creates github.com/<githubOwner>/<repoName>, git pushes
// main to it, then the resume repo (runtimeConfig.resumeRepo) is cloned, the card is added
// to index.html, and the commit is pushed so resume.devinsmini.com picks it up on deploy.
// Sandbox applications (applications.is_sandbox): the same steps against local bare repos
// under dataPath('sandbox-remotes'), so the whole flow runs without touching GitHub.

export interface PublishResult {
  repoUrl: string
  liveUrl: string | null
}

export async function publishDemo(demoId: number): Promise<PublishResult> {
  const demo = getDemo(demoId)
  if (!demo) throw new Error(`Demo ${demoId} not found`)
  const row = getAppWithJob(demo.applicationId)
  if (!row) throw new Error(`Application ${demo.applicationId} not found`)
  if (demo.status === 'published' && demo.repoUrl) return { repoUrl: demo.repoUrl, liveUrl: demo.liveUrl }
  if (demo.status !== 'built') throw new Error(`Demo ${demoId} is ${demo.status}; only a built demo can be published`)
  if (!demo.repoName || !demo.localPath || !existsSync(join(demo.localPath, '.git'))) {
    throw new Error(`Demo ${demoId} has no local git repository to publish`)
  }
  const sandbox = row.app.isSandbox
  const token = String(useRuntimeConfig().githubToken || '')
  if (!sandbox && !token) {
    throw new Error('The GitHub token is not set, so the demo cannot be published to GitHub. Nothing was pushed.')
  }

  updateDemo(demoId, { status: 'publishing' })
  try {
    const result = sandbox ? await publishToSandbox(demo) : await publishToGitHub(demo, token)
    appendBuildLog(demoId, `published ${sandbox ? 'to the sandbox remotes' : 'to GitHub'}: ${result.repoUrl}`)
    return result
  }
  catch (e) {
    // Back to built so a retry of the approval publishes again instead of skipping the demo.
    updateDemo(demoId, { status: 'built' })
    appendBuildLog(demoId, `publish failed: ${(e as Error)?.message || e}`)
    throw e
  }
}

function cardFor(demo: DemoRow, repoUrl: string): ResumeCard {
  const facts = readCardFacts(demo)
  return {
    repoName: demo.repoName!,
    title: demo.title,
    summary: demo.summary ?? '',
    techStack: parseJson<string[]>(demo.techStackJson, []),
    repoUrl,
    highlights: facts.highlights,
    testCount: facts.testCount,
    testCommand: demo.testCommand,
  }
}

function author() {
  const { name, contact } = candidateContact()
  if (!contact.email) throw new Error('The knowledge base has no profile Email for the resume commit')
  return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: contact.email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: contact.email }
}

/** Clone the resume repo, add the card, commit as Devin, push. Returns the new commit or null when the card was already there. */
async function addCardToResume(remote: string, card: ResumeCard, authEnv: Record<string, string>): Promise<string | null> {
  const work = mkdtempSync(join(dataPath('tmp', 'x'), '..', 'resume-'))
  try {
    await git(['clone', '-q', '--depth', '1', remote, work], dataDir(), authEnv, 180_000)
    const indexPath = join(work, 'index.html')
    if (!existsSync(indexPath)) throw new Error('The resume repo has no index.html at its root')
    const { html, changed } = insertCaseCard(readFileSync(indexPath, 'utf8'), card)
    if (!changed) return null
    writeFileSync(indexPath, html)
    await git(['add', 'index.html'], work)
    await git(['commit', '-q', '-m', `Add ${card.title} to selected work`], work, author())
    await git(['push', '-q', 'origin', 'HEAD'], work, authEnv, 180_000)
    return await git(['rev-parse', '--short', 'HEAD'], work)
  }
  finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// ── Sandbox ─────────────────────────────────────────────────

function sandboxRemote(name: string) {
  return join(dataPath('sandbox-remotes', '.keep'), '..', `${name}.git`)
}

async function ensureBare(path: string) {
  if (!existsSync(path)) await git(['init', '-q', '--bare', '-b', 'main', path], dataDir())
}

/** The sandbox copy of the resume repo, seeded once from NUXT_DEMO_SANDBOX_RESUME_SEED or the built-in page. */
export async function ensureSandboxResumeRemote(): Promise<string> {
  const remote = sandboxRemote('resume')
  if (existsSync(remote)) return remote
  await ensureBare(remote)
  const seed = String(useRuntimeConfig().demoSandboxResumeSeed || '')
  let html = SANDBOX_RESUME_FIXTURE
  let source = 'the built-in sandbox page'
  if (seed) {
    const file = existsSync(seed) && statSync(seed).isDirectory() ? join(seed, 'index.html') : seed
    if (!existsSync(file)) throw new Error(`NUXT_DEMO_SANDBOX_RESUME_SEED points at ${file}, which does not exist`)
    html = readFileSync(file, 'utf8')
    source = file
  }
  const work = mkdtempSync(join(dataPath('tmp', 'x'), '..', 'resume-seed-'))
  try {
    await git(['init', '-q', '-b', 'main'], work)
    writeFileSync(join(work, 'index.html'), html)
    await git(['add', 'index.html'], work)
    await git(['commit', '-q', '-m', 'Seed sandbox copy of the resume site'], work, { GIT_AUTHOR_NAME: 'job-hunter sandbox', GIT_AUTHOR_EMAIL: 'sandbox@localhost', GIT_COMMITTER_NAME: 'job-hunter sandbox', GIT_COMMITTER_EMAIL: 'sandbox@localhost' })
    await git(['push', '-q', pathToFileURL(remote).href, 'main:main'], work)
  }
  finally {
    rmSync(work, { recursive: true, force: true })
  }
  console.log(`[demo] seeded the sandbox resume remote from ${source}`)
  return remote
}

async function publishToSandbox(demo: DemoRow): Promise<PublishResult> {
  const remote = sandboxRemote(demo.repoName!)
  await ensureBare(remote)
  const url = pathToFileURL(remote).href
  await git(['push', '-q', url, 'main:main'], demo.localPath!)
  const resume = await ensureSandboxResumeRemote()
  // The card links to the GitHub URL the repo would have, as on the real site.
  const commit = await addCardToResume(pathToFileURL(resume).href, cardFor(demo, githubRepoUrl(demo.repoName!)), {})
  appendBuildLog(demo.id, commit ? `sandbox resume card committed ${commit} in ${resume}` : 'sandbox resume already had this card')
  return { repoUrl: url, liveUrl: null }
}

// ── GitHub ──────────────────────────────────────────────────

async function gh(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'job-hunter',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data: any = null
  try {
    data = text ? JSON.parse(text) : null
  }
  catch {
    data = text
  }
  return { status: res.status, data }
}

/** Token goes to git as an http header through environment config, never in argv or a remote URL. */
function gitAuthEnv(token: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  }
}

async function publishToGitHub(demo: DemoRow, token: string): Promise<PublishResult> {
  const config = useRuntimeConfig()
  const owner = config.githubOwner || 'Devin345458'
  const repo = demo.repoName!
  const auth = gitAuthEnv(token)
  const localHead = await git(['rev-parse', 'HEAD'], demo.localPath!)

  const existing = await gh(token, 'GET', `/repos/${owner}/${repo}`)
  if (existing.status === 200) {
    // Only reuse a repo that is empty or already holds this exact history (a retried publish).
    const branch = await gh(token, 'GET', `/repos/${owner}/${repo}/branches/main`)
    const empty = (await gh(token, 'GET', `/repos/${owner}/${repo}/commits?per_page=1`)).status === 409
    if (!empty && branch.data?.commit?.sha !== localHead) {
      throw new Error(`github.com/${owner}/${repo} already exists with other history. Rename or delete it, or discard this demo.`)
    }
  }
  else if (existing.status === 404) {
    const me = await gh(token, 'GET', '/user')
    if (me.status !== 200) throw new Error(`GitHub rejected the token (${me.status}): ${me.data?.message ?? ''}`)
    const body = {
      name: repo,
      description: (demo.summary ?? demo.title).replace(/\s+/g, ' ').slice(0, 340),
      private: false,
      has_issues: true,
      has_projects: false,
      has_wiki: false,
      auto_init: false,
    }
    const created = String(me.data.login).toLowerCase() === owner.toLowerCase()
      ? await gh(token, 'POST', '/user/repos', body)
      : await gh(token, 'POST', `/orgs/${owner}/repos`, body)
    if (created.status !== 201) throw new Error(`GitHub did not create ${owner}/${repo} (${created.status}): ${created.data?.message ?? ''}`)
  }
  else {
    throw new Error(`GitHub lookup for ${owner}/${repo} failed (${existing.status}): ${existing.data?.message ?? ''}`)
  }

  const remoteUrl = `https://github.com/${owner}/${repo}.git`
  await git(['push', '-q', remoteUrl, 'main:main'], demo.localPath!, auth, 180_000)
  const repoUrl = githubRepoUrl(repo)
  const resumeRepo = config.resumeRepo || 'Devin345458/resume'
  const commit = await addCardToResume(`https://github.com/${resumeRepo}.git`, cardFor(demo, repoUrl), auth)
  appendBuildLog(demo.id, commit ? `resume card pushed to ${resumeRepo} as ${commit}` : `${resumeRepo} already had this card`)
  return { repoUrl, liveUrl: null }
}

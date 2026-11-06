import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { repoCommits, repoFacts, repoSources } from '../../db/schema'
import { tokenAt } from './github'
import { repoCacheDir, runGit } from './git'
import { LARGE_COMMIT_FILES, excludedPathspecs } from './indexer'
import type { AppRepoTopic } from '#shared/types/repos'
import { appRepoTopics, isAppRepo } from './settings'

// Searches Devin's indexed commits for the terms one question expands into: commit messages and
// changed paths from the database, his diffs from the local clones (git log -G over his commit
// list only, cut to the matching lines), and dependency names from the manifests. A dependency
// alone is context, never evidence: evidence is always one of his commits.

export interface TermSet {
  /** Identifiers, API names, and words found in code, diffs, or commit messages. */
  code: string[]
  /** File extensions (".cs") or path fragments ("/scim/"). */
  paths: string[]
  /** Package names (npm, composer, pip, go, gem, cargo, nuget). */
  packages: string[]
}

export type HitReason = 'diff' | 'message' | 'path'

export interface CommitHit {
  repo: string
  sha: string
  url: string
  /** YYYY-MM-DD */
  date: string
  subject: string
  reasons: HitReason[]
  /** Changed paths that matched a path term or held a matching diff line. */
  paths: string[]
  /** Matching changed lines, cut short. Empty for message and path hits. */
  excerpt: string
}

export interface RepoPathSummary {
  repo: string
  /** His commits that touch a file matching a path term. */
  commits: number
  first: string
  last: string
}

export interface SearchResult {
  hits: CommitHit[]
  pathSummaries: RepoPathSummary[]
  dependencies: Array<{ repo: string; name: string; manifest: string }>
  languages: Array<{ repo: string; name: string }>
  repos: Array<{ repo: string; isPrivate: boolean; owner: string }>
  errors: string[]
  /** The terms that could make a commit a hit (subjectAnchors). */
  anchors: TermSet
  /** The topics this app's own repo was searched for, when the subject names one (appRepoScope). */
  appRepo: AppRepoScope | null
}

const MAX_HITS = 14
const MAX_PER_REPO = 6
const EXCERPT_LINE = 160
const EXCERPT_COMMIT = 700
const EXCERPT_TOTAL = 5000

function escapeJs(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function escapeEre(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Terms that are plain short words match as whole words, so "Go" never matches "good". */
export function termPattern(t: string) {
  const e = escapeJs(t)
  return /^[a-z0-9]{1,4}$/i.test(t) ? `(?<![A-Za-z0-9])${e}(?![A-Za-z0-9])` : e
}

/**
 * How a subject term (anchor) matches: a plain word or phrase matches whole words only, so "Rails"
 * never matches "guardrails" and "React" never matches "reactive"; a term with punctuation
 * ("socket.io", "@shopify/polaris", "queue:work") matches anywhere.
 */
export function anchorPattern(t: string) {
  const e = escapeJs(t).replace(/\s+/g, '\\s+')
  return /^[a-z0-9 ]+$/i.test(t) ? `(?<![A-Za-z0-9])${e}(?![A-Za-z0-9])` : e
}

/**
 * The message without trailer lines (Co-Authored-By, Signed-off-by, Claude-Session, "Generated
 * with"). They name the tools that helped, not the work, and "Claude" or "anthropic" in a trailer
 * matched every commit Claude co-wrote.
 */
export function messageBody(message: string): string {
  return message.split('\n').filter(l => !/^\s*(co-authored-by|signed-off-by|reviewed-by|claude-session)\s*:|generated with \[?claude/i.test(l)).join('\n')
}

/**
 * Words that sit in almost every codebase or commit log. As code terms they match unrelated work
 * ("query" in a jquery dependency, "schema" in a database migration), so they are dropped.
 */
const GENERIC_CODE = new Set([
  'api', 'apis', 'data', 'user', 'users', 'test', 'tests', 'config', 'client', 'server', 'model', 'models', 'type', 'types',
  'query', 'queries', 'mutation', 'mutations', 'schema', 'schemas', 'resolver', 'resolvers', 'request', 'response', 'fetch',
  'json', 'error', 'errors', 'index', 'util', 'utils', 'helper', 'helpers', 'service', 'services', 'store', 'state', 'app',
  'auth', 'token', 'tokens', 'endpoint', 'endpoints', 'route', 'routes', 'controller', 'component', 'components', 'event',
  'events', 'value', 'values', 'item', 'items', 'list', 'update', 'create', 'delete', 'save', 'load', 'build', 'deploy',
  'image', 'images', 'container', 'containers', 'volume', 'volumes', 'network', 'compose', 'setup', 'install', 'version',
  'subscription', 'subscriptions', 'fragment', 'fragments', 'directive', 'directives', 'field', 'fields', 'object', 'objects',
  // Seen in production's cached terms (repo_terms), each matching hundreds of unrelated commits in the
  // 2026-11-03 measurement (scripts/eval/keyword-evidence.ts): Terraform's provider, module, backend;
  // GraphQL's relay; SCIM's provisioning; GitHub's git, commit, push; Rust's async, impl, trait.
  'provider', 'providers', 'resource', 'resources', 'module', 'modules', 'backend', 'backends', 'frontend', 'relay',
  'provisioning', 'interpolation', 'protocol', 'tools', 'tool', 'prompts', 'prompt', 'sampling', 'workflow', 'workflows',
  'orchestration', 'durable', 'reaction', 'when', 'computed', 'observable', 'header', 'headers', 'method', 'methods',
  'status', 'socket', 'migration', 'migrations', 'print', 'def', 'import', 'export', 'render', 'props', 'performance',
  'lazy', 'transition', 'animate', 'agent', 'agents', 'autonomous', 'conversion', 'experiment', 'cohort', 'funnel',
  'impression', 'bounce', 'analytics', 'discovery', 'embedding', 'vector', 'semantic', 'headless', 'collection', 'hook',
  'hooks', 'content', 'contenttype', 'git', 'commit', 'push', 'pull', 'branch', 'merge', 'fork', 'clone', 'repository',
  'sync', 'reconcile', 'declarative', 'pipeline', 'pipelines', 'async', 'result', 'impl', 'trait', 'box', 'arc', 'unsafe',
  'defer', 'chan', 'locale', 'markdown', 'broadcast', 'worker', 'workers', 'deployment', 'infrastructure', 'authentication',
  'authorization', 'encryption', 'injection', 'idempotent', 'state management', 'reasoning', 'multi_turn', 'task_planning',
  'vision', 'gpt', 'llm', 'rake', 'routes', 'devise', 'idempotency', 'retry', 'webhook', 'webhooks', 'admin', 'storefront',
])

/** Trims, dedupes, and caps each list. dropGeneric false keeps generic words (signatures are curated). */
export function cleanTerms(t: TermSet, max = 12, dropGeneric = true): TermSet {
  const clean = (list: string[], min: number, generic = false) => [...new Map(list
    .map(s => String(s ?? '').trim())
    .filter(s => s.length >= min && s.length <= 60 && !/[\r\n]/.test(s))
    .filter(s => !generic || !dropGeneric || !GENERIC_CODE.has(s.toLowerCase()))
    .map(s => [s.toLowerCase(), s])).values()].slice(0, max)
  return { code: clean(t.code, 3, true), paths: clean(t.paths, 2), packages: clean(t.packages, 2, true) }
}

/**
 * ".graphql" matches the extension. "schema.graphql" and "shopify.app.toml" match a file name or a
 * longer path. "graphql/" and "/graphql/" match that folder anywhere, the repo root included.
 */
export function pathMatches(path: string, terms: string[]): boolean {
  const p = `/${path.toLowerCase()}`
  return terms.some((t) => {
    const x = t.toLowerCase()
    if (x.startsWith('.') && !x.includes('/')) return p.endsWith(x)
    if (x.endsWith('/')) return p.includes(x.startsWith('/') ? x : `/${x}`)
    return p.includes(x)
  })
}

// ── Signatures ──
// Words, files, folders, and packages that only a given subject produces: its known aliases. A
// commit that touches schema.graphql is GraphQL work even when its message says "product sync".
// They are added to the terms Claude gives, so a subject never depends on Claude remembering them,
// and they are anchors (subjectAnchors below): a match on one makes a commit a hit by itself.
// Every term here must be specific to its subject; a generic word belongs in no signature.

interface Signature {
  /**
   * Tested against the subject alone (the question only when there is no subject), and in the
   * chat also Devin's own message. Never the question text: "GitHub Copilot" in a question about
   * AI tools must not pull in GitHub's workflow files.
   */
  when: RegExp
  terms: TermSet
}

const SIGNATURES: Signature[] = [
  {
    when: /\bgraph\s?ql\b/i,
    terms: {
      code: ['graphql', 'gql`', 'ApolloClient', 'apollo'],
      paths: ['.graphql', '.gql', 'graphql/', 'schema.graphql', 'codegen.yml', 'codegen.ts', '.graphqlrc'],
      packages: ['graphql', '@apollo/client', 'apollo-server', 'graphql-request', 'urql', 'graphql-tag', 'nuwave/lighthouse', 'webonyx/graphql-php', 'rebing/graphql-laravel'],
    },
  },
  {
    when: /\bshopify\b/i,
    terms: {
      code: ['shopify', 'myshopify'],
      paths: ['shopify.app.toml', 'shopify.extension.toml', 'shopify.web.toml', '.liquid', 'shopify/'],
      packages: ['@shopify/shopify-api', '@shopify/app-bridge', '@shopify/polaris', '@shopify/shopify-app-remix', '@shopify/cli', 'osiset/laravel-shopify', 'shopify/shopify-api'],
    },
  },
  {
    when: /\bdocker\b|\bcontainers?\b/i,
    terms: { code: ['docker', 'dockerfile', 'dockerized', 'docker compose', 'docker-compose'], paths: ['dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', '.dockerignore'], packages: ['dockerode', 'testcontainers'] },
  },
  {
    when: /\bkubernetes\b|\bk8s\b|\bhelm\b/i,
    terms: { code: ['apiVersion', 'kubectl'], paths: ['k8s/', 'helm/', 'chart.yaml', 'kustomization.yaml'], packages: [] },
  },
  {
    when: /\bterraform\b|\binfrastructure as code\b/i,
    terms: { code: ['terraform', 'resource "aws_', 'hcl', 'tfstate', 'tfvars'], paths: ['.tf', '.tfvars', 'terraform/', '.terraform.lock.hcl'], packages: [] },
  },
  {
    when: /\bgithub actions\b|\bci\/cd\b|\bcontinuous integration\b/i,
    terms: { code: ['runs-on', 'uses: actions/'], paths: ['.github/workflows/'], packages: [] },
  },
  {
    when: /\bprisma\b/i,
    terms: { code: ['prisma'], paths: ['schema.prisma', 'prisma/'], packages: ['prisma', '@prisma/client'] },
  },
  {
    when: /\bflutter\b|\bdart\b/i,
    terms: { code: ['flutter', 'StatelessWidget'], paths: ['.dart', 'pubspec.yaml'], packages: [] },
  },
  {
    when: /\bcapacitor\b/i,
    terms: { code: ['@capacitor/'], paths: ['capacitor.config.ts', 'capacitor.config.json'], packages: ['@capacitor/core', '@capacitor/cli'] },
  },
  {
    when: /\breact native\b/i,
    terms: { code: ['react-native'], paths: ['metro.config.js'], packages: ['react-native', 'expo'] },
  },
  {
    when: /\bswift\b|\bios\b/i,
    terms: { code: ['SwiftUI', 'UIKit'], paths: ['.swift', '.xcodeproj/', 'podfile', 'package.swift'], packages: [] },
  },
  {
    when: /\bkotlin\b|\bandroid\b/i,
    terms: { code: ['AndroidManifest'], paths: ['.kt', 'androidmanifest.xml', 'build.gradle.kts'], packages: [] },
  },
  // Added 2026-11-03 with the subject anchor rule, from the ten measured subjects and the snapshot's 43 questions.
  {
    when: /\bscim\b/i,
    terms: { code: ['scim', 'ServiceProviderConfig', 'urn:ietf:params:scim'], paths: ['scim/', '/scim'], packages: ['scim2-parse-filter', 'scim-patch', 'scimgateway', 'arietimmerman/laravel-scim-server'] },
  },
  {
    when: /\bpass ?keys?\b|\bwebauthn\b|\bfido2?\b/i,
    terms: { code: ['webauthn', 'passkey', 'passkeys', 'PublicKeyCredential', 'navigator.credentials', 'FIDO2'], paths: ['webauthn', 'passkey'], packages: ['@simplewebauthn/server', '@simplewebauthn/browser', 'web-auth/webauthn-lib', 'laragear/webauthn', 'asbiin/laravel-webauthn', 'fido2-lib'] },
  },
  {
    when: /\boauth\b|\boidc\b|\bopenid\b|single sign[- ]on|\bsso\b/i,
    terms: { code: ['oauth', 'oauth2', 'OIDC', 'OpenID', 'authorization_code', 'refresh_token', 'PKCE', 'Socialite', 'SSO'], paths: ['oauth', 'oidc', 'sso/'], packages: ['laravel/passport', 'laravel/socialite', 'league/oauth2-client', 'league/oauth2-server', 'next-auth', 'oauth4webapi', 'simple-oauth2'] },
  },
  {
    when: /\bstripe\b|\bpayments?\b|\bcheckout\b|\bbilling\b|\bsubscriptions? billing\b/i,
    terms: { code: ['stripe', 'PaymentIntent', 'SetupIntent', 'checkout.session', 'braintree', 'authorize.net', 'authorizenet', 'paypal', 'RevenueCat', 'payment', 'payments', 'refund', 'refunds'], paths: ['stripe', 'payments/', 'billing/'], packages: ['stripe', '@stripe/stripe-js', '@stripe/react-stripe-js', 'stripe/stripe-php', 'laravel/cashier', 'braintree', 'authorizenet/authorizenet', '@revenuecat/purchases-js'] },
  },
  {
    when: /\bweb ?sockets?\b|\bsocket\.io\b|\breal[- ]?time\b/i,
    terms: { code: ['websocket', 'websockets', 'socket.io', 'wss://', 'laravel-echo', 'Pusher', 'Reverb', 'Soketi', 'realtime'], paths: ['websocket', 'channels.php', 'broadcasting.php', 'realtime/'], packages: ['socket.io', 'socket.io-client', 'ws', 'laravel-echo', 'pusher-js', 'pusher/pusher-php-server', 'beyondcode/laravel-websockets', 'laravel/reverb'] },
  },
  {
    when: /\bqueues?\b|\bbackground (jobs?|tasks?|workers?|processing)\b|\bsidekiq\b|\bcelery\b|\bbullmq\b/i,
    terms: { code: ['queue', 'queues', 'queued', 'enqueue', 'ShouldQueue', 'queue:work', 'Horizon', 'BullMQ', 'Sidekiq', 'Celery', 'job_batches', 'background job', 'background jobs'], paths: ['app/jobs/', '/jobs/', 'horizon.php', 'queue.php'], packages: ['bullmq', 'bull', 'bee-queue', 'laravel/horizon', 'sidekiq', 'celery', 'pg-boss'] },
  },
  {
    // Rails, not any Ruby: fastlane's Gemfile is Ruby but not Rails work.
    when: /\brails\b/i,
    terms: { code: ['rails', 'ActiveRecord', 'ActionController', 'ActiveJob'], paths: ['config/routes.rb', 'db/schema.rb', '.erb'], packages: ['rails', 'activerecord', 'actionpack'] },
  },
  {
    when: /\bruby\b(?! on rails)/i,
    terms: { code: ['ruby'], paths: ['.rb', 'gemfile', 'rakefile'], packages: [] },
  },
  {
    when: /\bpython\b|\bdjango\b|\bflask\b|\bfastapi\b/i,
    terms: { code: ['python', 'django', 'flask', 'fastapi', 'pytest'], paths: ['.py', 'requirements.txt', 'pyproject.toml', 'setup.py', 'pipfile'], packages: ['django', 'flask', 'fastapi', 'pytest'] },
  },
  {
    when: /\bgolang\b|^\s*go\s*$|\b(in|use|used|with|write|wrote) go\b/im,
    terms: { code: ['golang', 'goroutine', 'goroutines'], paths: ['.go', 'go.mod', 'go.sum'], packages: [] },
  },
  {
    when: /\brust\b/i,
    terms: { code: ['rust', 'cargo', 'tokio'], paths: ['.rs', 'cargo.toml'], packages: ['tokio', 'serde'] },
  },
  {
    when: /\btailwind/i,
    terms: { code: ['tailwind', 'tailwindcss'], paths: ['tailwind.config'], packages: ['tailwindcss'] },
  },
  {
    when: /\breact\b(?![ -]native)/i,
    terms: { code: ['React', 'ReactDOM', 'useState', 'useEffect', 'JSX', 'Next.js'], paths: ['.jsx', '.tsx'], packages: ['react', 'react-dom', 'react-router-dom'] },
  },
  {
    when: /\bvue(\.js|js)?\b|\bnuxt\b/i,
    terms: { code: ['vue', 'vuejs', 'nuxt', 'vuetify', 'pinia'], paths: ['.vue', 'nuxt.config'], packages: ['vue', 'nuxt', 'vuetify', 'pinia'] },
  },
  {
    when: /\bpostgres(ql)?\b/i,
    terms: { code: ['postgres', 'postgresql', 'psql', 'pgsql', 'pg_dump', 'psycopg'], paths: ['postgres'], packages: ['pg', 'psycopg2', 'psycopg', 'pgx', 'postgres'] },
  },
  {
    when: /\bmobx\b/i,
    terms: { code: ['mobx', 'makeObservable', 'makeAutoObservable', 'runInAction'], paths: [], packages: ['mobx', 'mobx-react', 'mobx-react-lite'] },
  },
  {
    when: /\bmcp\b|model context protocol/i,
    terms: { code: ['MCP', 'ModelContextProtocol', 'modelcontextprotocol'], paths: ['/mcp/', 'mcp.json', 'mcp/'], packages: ['@modelcontextprotocol/sdk'] },
  },
  {
    when: /\btemporal\b/i,
    terms: { code: ['temporalio', 'WorkflowClient'], paths: ['/temporal/'], packages: ['@temporalio/client', '@temporalio/worker', '@temporalio/workflow', 'temporalio', 'go.temporal.io/sdk'] },
  },
  {
    when: /\bnix(os|pkgs)?\b/i,
    terms: { code: ['nixpkgs', 'nix-shell', 'flake.nix', 'mkDerivation'], paths: ['.nix', 'flake.lock'], packages: [] },
  },
  {
    when: /\bastro\b/i,
    terms: { code: ['astro', 'astrojs'], paths: ['.astro', 'astro.config'], packages: ['astro'] },
  },
  {
    when: /internationali[sz]ation|locali[sz]ation|\bi18n\b|\bl10n\b|\btranslations?\b/i,
    terms: { code: ['i18n', 'l10n', 'internationalization', 'localization', 'translations', 'i18next', 'vue-i18n'], paths: ['/i18n/', '/locales/', '/lang/', '/translations/', '.arb', '.xliff'], packages: ['i18next', 'react-intl', 'vue-i18n', 'next-intl'] },
  },
  {
    when: /\bsoap\b|\bwsdl\b/i,
    terms: { code: ['soap', 'wsdl', 'SoapClient'], paths: ['.wsdl'], packages: ['zeep', 'suds', 'econea/nusoap'] },
  },
  {
    // Case-sensitive: "REST" the architecture, never "the rest of".
    when: /\bREST(ful)?\b/,
    terms: { code: ['REST API', 'RESTful', 'OpenAPI', 'Swagger'], paths: ['openapi.yaml', 'openapi.json', 'swagger.json', 'swagger.yaml'], packages: ['darkaonline/l5-swagger', 'swagger-ui-express'] },
  },
  {
    when: /\bcms\b|content management|wordpress|drupal|headless/i,
    terms: { code: ['CMS', 'WordPress', 'Drupal', 'Contentful', 'Strapi', 'Payload CMS', 'payloadcms', 'headless CMS'], paths: ['wp-content/', 'payload.config'], packages: ['@sanity/client', 'contentful', 'strapi', '@payloadcms/next'] },
  },
  {
    when: /\bgitops\b|argo ?cd|\bflux(cd)?\b/i,
    terms: { code: ['GitOps', 'ArgoCD', 'Argo CD', 'FluxCD', 'kustomize'], paths: ['kustomization.yaml', 'argocd/', 'flux/'], packages: [] },
  },
  {
    when: /infrastructure[ -]as[ -]code|\biac\b|cloudformation|pulumi|\bcdk\b|ansible/i,
    terms: { code: ['terraform', 'CloudFormation', 'Pulumi', 'aws-cdk', 'Ansible'], paths: ['.tf', 'terraform/', 'cloudformation', 'ansible/', 'cdk.json'], packages: ['aws-cdk-lib', 'pulumi', '@pulumi/pulumi'] },
  },
  {
    when: /\bmlops\b|\bmlflow\b|kubeflow|airflow|\bdvc\b/i,
    terms: { code: ['MLOps', 'mlflow', 'kubeflow', 'airflow', 'dvc'], paths: ['.dvc', 'dags/'], packages: ['mlflow', 'apache-airflow', 'dvc', 'kubeflow'] },
  },
  {
    when: /\bllms?\b|\bai[- ](native|powered)\b|\bagentic\b|\bagents?\b.*\b(ai|llm|platforms?)\b|\brag\b|\bembeddings?\b|\baeo\b/i,
    terms: { code: ['LLM', 'LLMs', 'agentic', 'tool_use', 'RAG', 'embeddings', 'OpenAI', 'Anthropic API', 'Claude API', 'Claude Code', 'subagent', 'subagents', 'autonomous', 'langchain', 'prompt caching'], paths: ['/agents/', '/llm/'], packages: ['@anthropic-ai/sdk', 'anthropic', 'openai', 'langchain', 'llamaindex', '@ai-sdk/anthropic'] },
  },
  {
    // Agentic and AI tooling work, found by what it touches: Claude Code config, skills, and
    // hooks, MCP servers, Orca, and the AI SDKs. Not for AEO or AI-powered search subjects.
    when: /\bai[- ]native\b|\bagentic\b|\bcoding (agents?|assistants?|tools?)\b|\bagents?\b.*\b(ai|llm|platforms?)\b|\b(internal|ai) agents?\b|\bai tool(s|ing)?\b|\bllms?\b.*\bintegrat|\bclaude code\b|\bcopilot\b/i,
    terms: {
      code: [],
      // Claude Code's own config folders, not all of .claude/: every app repo keeps its docs in
      // .claude/context/, and those roadmap edits are not AI tooling work. No CLAUDE.md (feature
      // commits edit it in passing) and no bare hooks/ (React keeps its hooks in src/hooks/).
      paths: ['.claude/agents/', '.claude/commands/', '.claude/skills/', '.claude/hooks/', '.claude/settings.json', 'agents.md', 'skill.md', 'skills/', '.mcp.json', 'mcp/', 'orca.yaml'],
      packages: ['@anthropic-ai/sdk', '@anthropic-ai/claude-agent-sdk', '@anthropic-ai/claude-code', 'openai', 'langchain', '@modelcontextprotocol/sdk'],
    },
  },
  {
    when: /\bsecurity\b|\bappsec\b|\bvulnerabilit|\bowasp\b/i,
    terms: { code: ['security', 'CVE', 'XSS', 'CSRF', 'SQL injection', 'vulnerability', 'vulnerable', 'pentest', 'OWASP', 'account takeover', 'privilege escalation', 'exploit'], paths: [], packages: [] },
  },
  {
    when: /\bseo\b|search engine optimi[sz]ation|structured (content|data)|json-ld|schema\.org/i,
    terms: { code: ['SEO', 'sitemap', 'meta description', 'og:image', 'schema.org', 'JSON-LD', 'robots.txt'], paths: ['sitemap', 'robots.txt'], packages: ['@nuxtjs/sitemap', 'next-sitemap', 'vue-meta'] },
  },
  {
    when: /\banalytics\b|experimentation|a\/b test|conversion (optimi[sz]ation|rate)|growth marketing/i,
    terms: { code: ['analytics', 'gtag', 'GA4', 'Google Analytics', 'A/B test', 'Mixpanel', 'PostHog', 'Amplitude'], paths: [], packages: ['mixpanel', 'mixpanel-browser', 'posthog-js', '@amplitude/analytics-browser', 'vue-gtag'] },
  },
  {
    // GitHub itself: workflows, Actions, the API. Its files say ".github/", its messages rarely say GitHub.
    when: /\bgithub\b(?!\s+copilot)/i,
    terms: { code: ['github', 'GitHub Actions', 'octokit'], paths: ['.github/'], packages: ['@octokit/rest', 'octokit', '@actions/core'] },
  },
  {
    when: /\bux\b|user experience|usability|\bui polish\b/i,
    terms: { code: ['UX', 'usability', 'mockup', 'restyle', 'polish'], paths: [], packages: [] },
  },
  {
    when: /\baccessibility\b|\ba11y\b|\bwcag\b/i,
    terms: { code: ['accessibility', 'a11y', 'aria-label', 'WCAG', 'screen reader'], paths: [], packages: ['axe-core', 'jest-axe', '@axe-core/playwright'] },
  },
]

/** The signature terms for whatever the text names, or empty lists. */
export function signatureTerms(text: string): TermSet {
  const out: TermSet = { code: [], paths: [], packages: [] }
  for (const s of SIGNATURES) {
    if (!s.when.test(text)) continue
    out.code.push(...s.terms.code)
    out.paths.push(...s.terms.paths)
    out.packages.push(...s.terms.packages)
  }
  return out
}

/**
 * Claude's terms with the signatures for the text added. Signatures go first so the per-list cap
 * never drops them, and they skip the generic word filter: they are curated per subject.
 */
export function withSignatures(terms: TermSet, text: string): TermSet {
  const sig = cleanTerms(signatureTerms(text), 60, false)
  const own = cleanTerms(terms, 12)
  const merge = (a: string[], b: string[]) => [...new Map([...a, ...b].map(t => [t.toLowerCase(), t] as const)).values()]
  return { code: merge(sig.code, own.code), paths: merge(sig.paths, own.paths), packages: merge(sig.packages, own.packages) }
}

/**
 * The version of the hit rules. repos:suggest stores it with each question's terms and judges a
 * question again when its hit set changed under newer rules. 2: subject anchors (2026-11-03).
 */
export const SEARCH_RULES = 2

// ── Anchors ──
// A commit is a hit only when it matches the subject itself: the subject's own words, a search
// term the subject or question names literally, or a signature (the subject's known aliases,
// files, and packages). Claude's other terms only rank hits that are already in; they never add
// one. Before this rule (2026-11-03 measurement) Terraform's 14 hits were all false, matched by
// provider, module, and backend.

/** Words too broad to make a commit a hit even when the subject says them ("UX design and polish"). */
const SUBJECT_STOP = new Set([
  'design', 'tools', 'tool', 'integration', 'integrations', 'knowledge', 'domain', 'products', 'product', 'management',
  'engineering', 'platform', 'platforms', 'pipeline', 'pipelines', 'skills', 'skill', 'experience', 'scale', 'at scale',
  'modern', 'framework', 'frameworks', 'system', 'systems', 'work', 'development', 'developer', 'code', 'software', 'web',
  'ai', 'search', 'content', 'rest', 'go', 'proficient', 'in', 'using', 'with', 'and', 'or', 'the', 'of', 'for', 'to',
  'real', 'project', 'projects', 'production', 'building', 'built', 'apps', 'app', 'features', 'feature',
  'static', 'dynamic', 'behavior', 'discovery', 'infrastructure', 'security', 'cache', 'styles', 'components', 'pages',
  'views', 'themes', 'plugins', 'config', 'src', 'tracking', 'experiments', 'variants', 'structured', 'schema',
])

/**
 * The subject's own words: its parts split on "or", "and", commas, and slashes, without stop words.
 * Only SUBJECT_STOP filters them: a subject named by a word that is noise as a Claude term
 * ("Webhooks", "Authentication") still anchors on its own name.
 */
export function subjectParts(subject: string): string[] {
  return subject.split(/,|\/|\(|\)|\bor\b|\band\b|&/i)
    .map(p => p.replace(/\b(proficient in|experience with|knowledge of|using)\b/gi, ' ').replace(/\s+/g, ' ').trim())
    .filter(p => p.length >= 2 && p.split(' ').length <= 3)
    .filter(p => !p.split(' ').every(w => SUBJECT_STOP.has(w.toLowerCase())))
    // A one-word plural also matches its singular: "Webhooks" finds "webhook".
    .flatMap(p => (/^[a-z]{4,}s$/i.test(p) && !/ss$/i.test(p) ? [p, p.slice(0, -1)] : [p]))
}

function squash(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * The text names the term: as whole words, or as the same letters ("tailwindcss" for "Tailwind CSS").
 * A broad word never counts as named ("/infrastructure/" for "Infrastructure visualization").
 */
function namedIn(term: string, text: string, parts: string[]): boolean {
  const t = term.replace(/^[./]+|\/+$/g, '').trim()
  if (t.length < 2) return false
  const sq = squash(t)
  if (sq.length >= 3 && parts.some(p => squash(p) === sq)) return true
  if (SUBJECT_STOP.has(t.toLowerCase()) || GENERIC_CODE.has(t.toLowerCase())) return false
  return new RegExp(anchorPattern(t), 'i').test(text)
}

/**
 * The anchors for a search: what can make a commit a hit. subject is the question's subject (null
 * in the general chat, where only signatures and terms the text names count); text is the subject,
 * the question, and in the chat Devin's message.
 */
export function subjectAnchors(terms: TermSet, subject: string | null, text: string, signatureText?: string): TermSet {
  const sig = signatureTerms(signatureText ?? (subject?.trim() || text))
  const parts = subject ? subjectParts(subject) : []
  const named = (t: string) => namedIn(t, text, parts)
  return cleanTerms({
    code: [...sig.code, ...parts, ...terms.code.filter(named), ...terms.packages.filter(named)],
    paths: [...sig.paths, ...terms.paths.filter(named)],
    packages: [...sig.packages, ...terms.packages.filter(named)],
  }, 80, false)
}

// ── This app's own repo ──
// Its commits name every skill as data, so it is searched only for a subject that names one of the
// topics Devin listed (appRepoTopics), and then only for what that part of the subject and the
// topic itself anchor on: a commit message that says "GraphQL" is never a GraphQL hit here.

export interface AppRepoScope {
  /** The parts of the subject that named a topic. */
  parts: string[]
  /** The parts of the topics they named ("Drizzle" of "SQLite and Drizzle"), with the other name of an "X with Y" part. */
  topicParts: string[]
  topics: AppRepoTopic[]
  /** The most its commits support on their own: yes when any matched topic allows Yes. */
  cap: 'yes' | 'some'
}

/** Words that never decide a topic match: filler, levels, and words every subject uses. */
const TOPIC_STOP = new Set([
  'the', 'a', 'an', 'of', 'for', 'to', 'in', 'on', 'at', 'by', 'with', 'and', 'or', 'via', 'using', 'use', 'used', 'uses',
  'experience', 'experienced', 'knowledge', 'proficient', 'proficiency', 'familiarity', 'familiar', 'skill', 'skills',
  'development', 'developing', 'developer', 'engineering', 'engineer', 'building', 'build', 'built', 'design', 'designing',
  'real', 'world', 'project', 'projects', 'production', 'work', 'working', 'modern', 'integration', 'integrations',
  'integrating', 'integrate', 'integrated', 'leveraging', 'leverage', 'tool', 'tools', 'tooling', 'system', 'systems',
  'platform', 'platforms', 'framework', 'frameworks', 'app', 'apps', 'application', 'applications', 'software', 'web',
  'code', 'coding', 'based', 'driven', 'powered', 'strong', 'solid', 'deep', 'expert', 'expertise', 'understanding',
  'hands', 'advanced', 'deploy', 'deploys', 'deploying', 'deployment', 'deployments',
])

/** Spellings that mean the same topic word: "agentic" is agents, "LLMs" is LLM, "Vue.js" is Vue. */
const TOPIC_ALIASES: Record<string, string> = {
  agentic: 'agent', llms: 'llm', genai: 'llm', evals: 'evaluation', eval: 'evaluation', evaluations: 'evaluation',
  vuejs: 'vue', nuxtjs: 'nuxt', nodejs: 'node', ts: 'typescript', sqlite3: 'sqlite',
}

function topicWord(w: string): string {
  let x = TOPIC_ALIASES[w] ?? w
  if (/^[a-z]{3,}ies$/.test(x)) x = `${x.slice(0, -3)}y`
  else if (/^[a-z]{3,}s$/.test(x) && !/ss$/.test(x)) x = x.slice(0, -1)
  return TOPIC_ALIASES[x] ?? x
}

/** The words of one part that decide a match, normalized. */
export function topicWords(text: string): string[] {
  const t = text.toLowerCase()
    .replace(/\blarge language models?\b|\bgenerative ai\b|\bgen ai\b/g, ' llm ')
    .replace(/\b(vue|nuxt|node)\.js\b/g, '$1')
  return [...new Set(t.split(/[^a-z0-9#+]+/).filter(Boolean).filter(w => !TOPIC_STOP.has(w)).map(topicWord).filter(w => !TOPIC_STOP.has(w)))]
}

/**
 * Words that make a subject about AI without saying "AI": "Internal agents" names "AI agents",
 * "LLM evaluation" names "AI evaluation", "Third-party vendor evaluation" does not.
 */
const IMPLIES_AI = new Set(['llm', 'agent', 'claude', 'anthropic', 'openai', 'gpt', 'chatgpt', 'gemini', 'copilot', 'prompt', 'rag', 'mcp', 'ml'])

/** A subject or topic split into its parts: on commas, slashes, brackets, and, or, with. */
export function topicParts(text: string): string[] {
  return topicSegments(text).flat()
}

/**
 * The same parts grouped: "X with Y" is one piece of work under two names ("browser automation
 * with Playwright"), so naming either brings both; "SQLite and Drizzle" are two.
 */
function topicSegments(text: string): string[][] {
  return text.split(/,|;|\/|\(|\)|&|\band\b|\bor\b|\bincluding\b|\bsuch as\b/i)
    .map(seg => seg.split(/\bwith\b/i).map(p => p.replace(/\s+/g, ' ').trim()).filter(p => topicWords(p).length > 0))
    .filter(seg => seg.length > 0)
}

/**
 * The topics a subject names: a topic part matches a part of the subject when every word that
 * decides it is in that part, AI counting as said when the subject names an AI word
 * (IMPLIES_AI): "LLM" names "LLM integration", "Internal agents" names "AI agents", "Vue 3
 * Composition API" names "Vue"; "REST API" names nothing, nor does "GraphQL" or "Third-party vendor
 * evaluation". Null when it names none, and then this app's repo is not searched.
 */
export function appRepoScope(subject: string | null | undefined, topics: AppRepoTopic[] = appRepoTopics()): AppRepoScope | null {
  const text = String(subject ?? '').trim()
  if (!text || !topics.length) return null
  const parts = new Set<string>()
  const named = new Set<string>()
  const matched = new Map<string, AppRepoTopic>()
  const aboutAi = topicWords(text).some(w => w === 'ai' || IMPLIES_AI.has(w))
  const subjectSide = topicParts(text).map(p => ({ p, words: new Set([...topicWords(p), ...(aboutAi ? ['ai'] : [])]) }))
  for (const topic of topics) {
    for (const seg of topicSegments(topic.name)) {
      for (const tp of seg) {
        const need = topicWords(tp)
        for (const s of subjectSide) {
          if (!need.every(w => s.words.has(w))) continue
          parts.add(s.p)
          for (const x of seg) named.add(x)
          matched.set(topic.name.toLowerCase(), topic)
        }
      }
    }
  }
  if (!matched.size) return null
  const list = [...matched.values()]
  return { parts: [...parts], topicParts: [...named], topics: list, cap: list.some(t => t.cap === 'yes') ? 'yes' : 'some' }
}

/**
 * The topics any of the texts names, each text read on its own: the subject first, then the
 * wordings its question was asked as (its "Asked as:" list and its catalog skill's name and
 * phrasings, appRepoScopeTexts() in skill-catalog.ts). A catalog skill takes a generic name that
 * holds none of the topic words ("Using AI in unsupervised processes"), while the postings it
 * covers say "Integrating with LLMs" and "Internal agents and agent platforms". Null when none
 * names a topic.
 */
export function appRepoScopeOf(texts: Array<string | null | undefined>, topics: AppRepoTopic[] = appRepoTopics()): AppRepoScope | null {
  const scopes = [...new Set(texts.map(t => String(t ?? '').trim()).filter(Boolean))]
    .map(t => appRepoScope(t, topics))
    .filter((s): s is AppRepoScope => !!s)
  if (!scopes.length) return null
  if (scopes.length === 1) return scopes[0]!
  const topicsBy = new Map<string, AppRepoTopic>()
  for (const s of scopes) for (const t of s.topics) topicsBy.set(t.name.toLowerCase(), t)
  const list = [...topicsBy.values()]
  return {
    parts: [...new Set(scopes.flatMap(s => s.parts))],
    topicParts: [...new Set(scopes.flatMap(s => s.topicParts))],
    topics: list,
    cap: list.some(t => t.cap === 'yes') ? 'yes' : 'some',
  }
}

/**
 * The level after this app's repo has its say: a Yes that rests only on its commits, for a subject
 * whose topics all count "Up to Some experience" (the frameworks the agents wrote in), becomes
 * Some experience. Any other record behind the Yes keeps it.
 */
export function appRepoLevel<L extends string>(level: L, scope: AppRepoScope | null, onlyThisRepo: boolean): L | 'Some experience' {
  return level === 'Yes' && onlyThisRepo && scope?.cap === 'some' ? 'Some experience' : level
}

/**
 * Its docs for coding agents and its task list (AGENTS.md, TASKS.md, CLAUDE.md, README.md) restate
 * every subject as data, so their names never make one of its commits a hit: "AGENTS.md" in a
 * message is a file, not agent work.
 */
const APP_REPO_DOCS = /\b(?:agents|tasks|claude|readme)\.md\b/gi

/** One of this app's commit messages as its anchors read it: trailers and its docs file names left out. */
export function appRepoMessage(message: string): string {
  return messageBody(message).replace(APP_REPO_DOCS, ' ')
}

/** A changed path of this app's repo that can anchor a hit: never its docs files. */
export function appRepoPath(path: string): boolean {
  return !/(?:^|\/)(?:agents|tasks|claude|readme)\.md$/i.test(path)
}

/**
 * What can make one of this app's commits a hit: the anchors of the subject parts that named a
 * topic (as for every repo, with only Claude's terms those parts name), plus the words and
 * signatures of the topic parts they named, so the topic decides what counts, never the rest of
 * the question.
 */
export function appRepoAnchors(scope: AppRepoScope, terms: TermSet = { code: [], paths: [], packages: [] }): TermSet {
  const subject = scope.parts.join(', ')
  const own = subjectAnchors(terms, subject, scope.parts.join('\n'), subject)
  const code: string[] = [...own.code]
  const paths: string[] = [...own.paths]
  const packages: string[] = [...own.packages]
  // Only the topic parts the subject named, never the rest of the topic: a Drizzle question
  // anchors on Drizzle, not on the SQLite of "SQLite and Drizzle".
  const named = scope.topicParts.join(', ')
  const t = subjectAnchors({ code: [], paths: [], packages: [] }, named, scope.topicParts.join('\n'), named)
  code.push(...t.code)
  paths.push(...t.paths)
  packages.push(...t.packages)
  // A part decided by one word besides AI anchors on that word too ("Coolify deploys" on
  // Coolify, "AI agents" on agent).
  for (const tp of scope.topicParts) {
    const w = topicWords(tp).filter(x => x !== 'ai')
    if (w.length === 1 && w[0]!.length >= 3) code.push(w[0]!, `${w[0]!}s`)
  }
  // What this repo's own commits say for the AI topics the subject named (APP_REPO_SIGNATURES).
  const sig = appRepoSignatureTerms(scope.topicParts.join('\n'))
  code.push(...sig.code)
  paths.push(...sig.paths)
  packages.push(...sig.packages)
  return cleanTerms({ code, paths: paths.filter(p => appRepoPath(p) && !APP_REPO_NOT_PATH_ANCHORS.has(p.toLowerCase())), packages }, 120, false)
}

/**
 * Signature paths that mean something else in this repo: its skills/ folders hold the skill
 * catalog's screens and routes (app/components/skills/), not Claude Code skills.
 */
const APP_REPO_NOT_PATH_ANCHORS = new Set(['skills/'])

// What this app's own commits say about its AI work. They name Claude, Anthropic, the Agent SDK,
// structured output, and agents, and almost never "LLM": on the 2026-11-05 snapshot 1 of its
// commits says LLM against 57 that say Claude and 18 that say agent, while the trading engine has
// 204 that say LLM, so the LLM signature alone left this app out of every LLM answer. These anchor
// only this repo, only for a topic part the subject named (Devin edits the topic names, so each
// is matched by its words), and every term is specific to the AI work here: a commit that says
// Claude in this repo is about the Claude calls it makes (trailers are already left out).
const APP_REPO_SIGNATURES: Signature[] = [
  {
    when: /\bllms?\b|large language models?|\bclaude\b|\banthropic\b/i,
    terms: { code: ['Claude', 'Anthropic', 'Agent SDK', 'structured output', 'structured outputs'], paths: ['server/utils/agent-backend.ts'], packages: ['@anthropic-ai/sdk', '@anthropic-ai/claude-agent-sdk'] },
  },
  {
    when: /\bagents?\b|\bagentic\b/i,
    terms: { code: ['agent', 'agents', 'Agent SDK', 'subagent', 'subagents'], paths: ['server/utils/agent-backend.ts'], packages: ['@anthropic-ai/claude-agent-sdk'] },
  },
  {
    when: /\bagent sdk\b/i,
    terms: { code: ['Agent SDK', 'claude-agent-sdk', 'Claude Code'], paths: ['server/utils/agent-backend.ts'], packages: ['@anthropic-ai/claude-agent-sdk'] },
  },
  {
    when: /structured outputs?/i,
    terms: { code: ['structured output', 'structured outputs', 'json_schema', 'aiStructured'], paths: [], packages: [] },
  },
  {
    when: /prompt caching/i,
    terms: { code: ['prompt caching', 'cachedPrompt', 'cache breakpoint', 'cache breakpoints'], paths: [], packages: [] },
  },
]

/** The app repo signature terms for whatever the topic parts name, or empty lists. */
function appRepoSignatureTerms(text: string): TermSet {
  const out: TermSet = { code: [], paths: [], packages: [] }
  for (const s of APP_REPO_SIGNATURES) {
    if (!s.when.test(text)) continue
    out.code.push(...s.terms.code)
    out.paths.push(...s.terms.paths)
    out.packages.push(...s.terms.packages)
  }
  return out
}

function depMatches(name: string, terms: string[]): boolean {
  const n = name.toLowerCase()
  return terms.some((t) => {
    const x = t.toLowerCase()
    return n === x || n.startsWith(`${x}/`) || (x.length >= 5 && n.includes(x))
  })
}

interface DiffHit {
  paths: Set<string>
  lines: string[]
}

/** Parses `git log -p --format=%x1e%H` and keeps changed lines that match the JS pattern. */
function parseDiffHits(out: string, re: RegExp): Map<string, DiffHit> {
  const hits = new Map<string, DiffHit>()
  for (const rec of out.split('\x1e')) {
    const nl = rec.indexOf('\n')
    const sha = (nl >= 0 ? rec.slice(0, nl) : rec).trim()
    if (!/^[0-9a-f]{40,64}$/.test(sha)) continue
    let file = ''
    const hit: DiffHit = { paths: new Set(), lines: [] }
    for (const line of rec.slice(nl + 1).split('\n')) {
      if (line.startsWith('diff --git ')) {
        const m = / b\/(.+)$/.exec(line)
        file = m ? m[1]! : ''
        continue
      }
      if (line.startsWith('+++ ') || line.startsWith('--- ') || line.startsWith('Binary files')) continue
      if ((line.startsWith('+') || line.startsWith('-')) && re.test(line.slice(1))) {
        hit.paths.add(file)
        if (hit.lines.length < 8) {
          const text = line.slice(1).trim().replace(/\s+/g, ' ')
          hit.lines.push(`${file}: ${line[0]} ${text.length > EXCERPT_LINE ? `${text.slice(0, EXCERPT_LINE - 1)}…` : text}`)
        }
      }
    }
    if (hit.paths.size) hits.set(sha, hit)
  }
  return hits
}

/**
 * opts.diffs false skips the diff search over the local clones (git log -G, up to two minutes a
 * repo), so the chat answers in seconds from messages, paths, and manifests alone.
 * opts.anchors names the subject (subjectAnchors): only a match on an anchor makes a commit a
 * hit, and a hit that also matches one of the other terms ranks higher. Without it every term is
 * an anchor.
 */
export async function searchEvidence(rawTerms: TermSet, log: (m: string) => void = () => {}, opts: { diffs?: boolean; anchors?: { subject: string | null; text: string; signatureText?: string; scopeTexts?: string[] } } = {}): Promise<SearchResult> {
  // Already cleaned by whoever built them (withSignatures keeps the curated signature words); this only bounds them.
  const terms = cleanTerms(rawTerms, 80, false)
  const anchors = opts.anchors ? subjectAnchors(terms, opts.anchors.subject, opts.anchors.text, opts.anchors.signatureText) : terms
  const db = useDb()
  // This app's own repo names every skill as data: it is searched only for a subject that names one
  // of its topics, or whose question was asked as wording that does (scopeTexts: the catalog
  // skill's phrasings and the "Asked as:" list), and never without a subject to check (appRepoScope).
  const app = opts.anchors ? appRepoScopeOf([opts.anchors.subject?.trim() || opts.anchors.signatureText || opts.anchors.text, ...(opts.anchors.scopeTexts ?? [])]) : null
  const repos = db.select().from(repoSources).where(and(eq(repoSources.included, true), isNotNull(repoSources.indexedAt))).all()
    .filter(r => !isAppRepo(r.fullName) || !!app)
  const result: SearchResult = {
    hits: [],
    pathSummaries: [],
    dependencies: [],
    languages: [],
    repos: repos.map(r => ({ repo: r.fullName, isPrivate: r.isPrivate, owner: r.owner })),
    errors: [],
    anchors,
    appRepo: app && repos.some(r => isAppRepo(r.fullName)) ? app : null,
  }
  if (!repos.length) return result
  // Its packages and languages are never read: every one of them would match some subject.
  const names = repos.map(r => r.fullName).filter(n => !isAppRepo(n))

  // Anchors make a hit; the other terms only rank one.
  const matcher = (a: TermSet) => {
    const words = [...a.code, ...a.packages]
    return { anchors: a, words, re: words.length ? new RegExp(words.map(anchorPattern).join('|'), 'i') : null }
  }
  const main = matcher(anchors)
  const appMatch = app ? matcher(appRepoAnchors(app, terms)) : null
  const anchorKeys = new Set([...anchors.code, ...anchors.packages, ...anchors.paths].map(t => t.toLowerCase()))
  const supportWords = [...terms.code, ...terms.packages].filter(t => !anchorKeys.has(t.toLowerCase()))
  const supportRe = supportWords.length ? new RegExp(supportWords.map(termPattern).join('|'), 'i') : null
  const supportPaths = terms.paths.filter(p => !anchorKeys.has(p.toLowerCase()))

  for (const f of names.length ? db.select().from(repoFacts).where(inArray(repoFacts.repo, names)).all() : []) {
    if (f.kind === 'dependency' && (depMatches(f.name, terms.packages) || depMatches(f.name, terms.code))) {
      result.dependencies.push({ repo: f.repo, name: f.name, manifest: f.detail ?? '' })
    }
    if (f.kind === 'language' && [...terms.code, ...terms.packages, ...terms.paths.map(p => p.replace(/^\./, ''))].some(t => t.toLowerCase() === f.name.toLowerCase())) {
      result.languages.push({ repo: f.repo, name: f.name })
    }
  }

  const all: Array<CommitHit & { score: number }> = []
  for (const repo of repos) {
    const own = isAppRepo(repo.fullName)
    const { anchors: repoAnchors, words: anchorWords, re: anchorRe } = own ? appMatch! : main
    const commits = db.select().from(repoCommits).where(eq(repoCommits.repo, repo.fullName)).all()
    if (!commits.length) continue
    const byRepo = new Map<string, CommitHit & { score: number }>()
    const add = (c: typeof commits[number], reason: HitReason, paths: string[] = [], excerpt = '') => {
      let h = byRepo.get(c.sha)
      if (!h) {
        h = {
          repo: repo.fullName,
          sha: c.sha,
          url: c.url,
          date: c.authoredAt.slice(0, 10),
          subject: c.message.split('\n')[0]!.slice(0, 200),
          reasons: [],
          paths: [],
          excerpt: '',
          score: 0,
        }
        byRepo.set(c.sha, h)
      }
      if (!h.reasons.includes(reason)) {
        h.reasons.push(reason)
        h.score += reason === 'diff' ? 3 : reason === 'message' ? 2 : 1
      }
      for (const p of paths) if (!h.paths.includes(p) && h.paths.length < 6) h.paths.push(p)
      if (excerpt && !h.excerpt) h.excerpt = excerpt
    }

    // Messages (trailers left out) and paths, from the index.
    const pathOnly: typeof commits = []
    for (const c of commits) {
      const paths = (JSON.parse(c.pathsJson ?? '[]') as string[]).filter(p => !own || appRepoPath(p))
      const inMessage = !!anchorRe && anchorRe.test(own ? appRepoMessage(c.message) : messageBody(c.message))
      if (inMessage) add(c, 'message')
      if (repoAnchors.paths.length) {
        const matched = paths.filter(p => pathMatches(p, repoAnchors.paths))
        if (matched.length) {
          if (inMessage) add(c, 'path', matched)
          else pathOnly.push(c)
        }
      }
    }
    if (pathOnly.length) {
      const sorted = [...pathOnly].sort((a, b) => a.authoredAt.localeCompare(b.authoredAt))
      result.pathSummaries.push({ repo: repo.fullName, commits: pathOnly.length, first: sorted[0]!.authoredAt.slice(0, 10), last: sorted[sorted.length - 1]!.authoredAt.slice(0, 10) })
      // The earliest and the latest two stand for the rest.
      for (const c of [...new Set([sorted[0]!, sorted[1], sorted[sorted.length - 2], sorted[sorted.length - 1]!].filter(Boolean))] as typeof commits) {
        add(c, 'path', (JSON.parse(c.pathsJson ?? '[]') as string[]).filter(p => (!own || appRepoPath(p)) && pathMatches(p, repoAnchors.paths)))
      }
    }

    // His diffs, from the clone: only his indexed commits, only searchable paths. Never this app's
    // own repo, whose files hold every skill name as data.
    if (anchorRe && opts.diffs !== false && !own) {
      const shas = commits.filter(c => (JSON.parse(c.pathsJson ?? '[]') as string[]).length < LARGE_COMMIT_FILES).map(c => c.sha)
      const ere = `(${anchorWords.map(escapeEre).join('|')})`
      const r = await runGit([
        '-c', 'core.quotePath=false', 'log', '--no-walk=unsorted', '--stdin', '--regexp-ignore-case', `-G${ere}`,
        '-p', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--format=%x1e%H',
        '--', '.', ...excludedPathspecs(),
      ], { cwd: repoCacheDir(repo.fullName), token: tokenAt(repo.tokenIndex), input: `${shas.join('\n')}\n`, timeoutMs: 120_000, maxBytes: 8 * 1024 * 1024 })
      if (r.code !== 0 && !r.truncated) {
        result.errors.push(`${repo.fullName}: diff search failed`)
        log(`${repo.fullName}: diff search failed (${r.stderr.split('\n').filter(l => l && !/promisor/i.test(l)).join(' ').slice(0, 200)})`)
      }
      const bySha = new Map(commits.map(c => [c.sha, c] as const))
      for (const [sha, d] of parseDiffHits(r.stdout, anchorRe)) {
        const c = bySha.get(sha)
        if (!c) continue
        let excerpt = d.lines.join('\n')
        if (excerpt.length > EXCERPT_COMMIT) excerpt = `${excerpt.slice(0, EXCERPT_COMMIT - 1)}…`
        add(c, 'diff', [...d.paths], excerpt)
      }
    }
    // Ranking only: a hit whose message or files also match one of the other terms gains a point.
    if (supportRe || supportPaths.length) {
      const bySha = new Map(commits.map(c => [c.sha, c] as const))
      for (const h of byRepo.values()) {
        const c = bySha.get(h.sha)
        if (!c) continue
        const body = messageBody(c.message)
        const files = JSON.parse(c.pathsJson ?? '[]') as string[]
        if ((supportRe && supportRe.test(body)) || (supportPaths.length && files.some(p => pathMatches(p, supportPaths)))) h.score += 1
      }
    }
    all.push(...[...byRepo.values()].sort((a, b) => b.score - a.score || b.date.localeCompare(a.date)).slice(0, MAX_PER_REPO))
  }

  // Strongest first across repos, then a budget on the excerpt text sent anywhere.
  let budget = EXCERPT_TOTAL
  result.hits = all
    .sort((a, b) => b.score - a.score || b.date.localeCompare(a.date))
    .slice(0, MAX_HITS)
    .map(({ score, ...h }) => {
      if (h.excerpt.length > budget) h.excerpt = budget > 80 ? `${h.excerpt.slice(0, budget - 1)}…` : ''
      budget -= h.excerpt.length
      return h
    })
  return result
}

// The ten subjects the GitHub evidence keyword measurement runs (scripts/eval/keyword-evidence.ts),
// with the terms the keyword search gets. GraphQL and Terraform use the terms production cached in
// repo_suggestions (Claude's repo_terms call); the others are written by hand in the same style,
// generously, so the keyword side is not handicapped. withSignatures() adds the built-in path
// signatures on top, exactly as repos:suggest does.

import type { TermSet } from '../../server/utils/repos/search'

export interface EvalSubject {
  subject: string
  /** Asked the way a knows or has_done question would ask it. */
  question: string
  terms: TermSet
}

export const SUBJECTS: EvalSubject[] = [
  {
    subject: 'GraphQL',
    question: 'Do you have experience building or consuming GraphQL APIs?',
    terms: { code: ['GraphQL', 'apollo', 'gql', 'SDL', 'introspection'], paths: ['.graphql', '.gql', '/graphql/'], packages: ['apollo-server', 'apollo-client', '@apollo/client', 'graphql', 'graphql-core', 'graphene', 'strawberry-graphql', 'relay'] },
  },
  {
    subject: 'SCIM',
    question: 'Have you implemented SCIM user provisioning?',
    terms: { code: ['scim', '/scim/v2', 'ServiceProviderConfig', 'urn:ietf:params:scim', 'ResourceTypes', 'provisioning'], paths: ['/scim/', 'scim/'], packages: ['scim2-parse-filter', 'scimgateway', 'scim-patch', 'scim2', 'arietimmerman/laravel-scim-server'] },
  },
  {
    subject: 'Passkeys or WebAuthn',
    question: 'Have you implemented passkeys or WebAuthn login?',
    terms: { code: ['webauthn', 'passkey', 'navigator.credentials', 'PublicKeyCredential', 'FIDO2', 'attestation', 'authenticator'], paths: ['/webauthn/', 'passkey'], packages: ['@simplewebauthn/server', '@simplewebauthn/browser', 'web-auth/webauthn-lib', 'laragear/webauthn', 'asbiin/laravel-webauthn', 'fido2-lib'] },
  },
  {
    subject: 'Terraform',
    question: 'Do you have experience with Terraform?',
    terms: { code: ['terraform', 'tfstate', 'tfvars', 'HCL', 'provider', 'resource', 'module', 'backend', 'interpolation', 'aws_instance'], paths: ['.tf', '.tfvars', '/terraform/', '.tfstate'], packages: ['terraform', 'terraform-provider-aws', 'terraform-provider-google', 'terraform-provider-azurerm'] },
  },
  {
    subject: 'Docker',
    question: 'Do you have experience with Docker?',
    terms: { code: ['docker', 'Dockerfile', 'docker-compose', 'dockerized', 'EXPOSE', 'ENTRYPOINT'], paths: ['dockerfile', 'docker-compose.yml', '.dockerignore', 'docker/'], packages: ['dockerode', 'testcontainers'] },
  },
  {
    subject: 'Shopify apps',
    question: 'Have you built Shopify apps?',
    terms: { code: ['shopify', 'myshopify', 'ShopifyApp', 'AppBridge', 'app/uninstalled', 'storefront'], paths: ['shopify.app.toml', '.liquid', 'shopify/'], packages: ['@shopify/shopify-api', '@shopify/app-bridge', '@shopify/polaris', 'osiset/laravel-shopify', 'shopify_app'] },
  },
  {
    subject: 'Background jobs and queues',
    question: 'Have you built background job processing with queues?',
    terms: { code: ['ShouldQueue', 'queue:work', 'Horizon', 'BullMQ', 'Sidekiq', 'Celery', 'job queue', 'dispatch(', 'worker', 'queue'], paths: ['app/Jobs/', '/jobs/', '/queues/', 'horizon.php', 'queue.php'], packages: ['bullmq', 'bull', 'bee-queue', 'laravel/horizon', 'sidekiq', 'celery', 'agenda', 'pg-boss'] },
  },
  {
    subject: 'OAuth',
    question: 'Have you implemented OAuth login or OAuth integrations?',
    terms: { code: ['oauth', 'OAuth2', 'access_token', 'refresh_token', 'authorization_code', 'client_secret', 'redirect_uri', 'PKCE'], paths: ['/oauth/', 'oauth'], packages: ['laravel/passport', 'laravel/socialite', 'league/oauth2-client', 'passport', 'oauth4webapi', 'simple-oauth2', 'next-auth'] },
  },
  {
    subject: 'Stripe or payments',
    question: 'Have you integrated Stripe or another payment processor?',
    terms: { code: ['stripe', 'PaymentIntent', 'checkout.session', 'paymentMethod', 'braintree', 'authorize.net', 'payment gateway', 'refund'], paths: ['/payments/', '/billing/', 'stripe'], packages: ['stripe', '@stripe/stripe-js', '@stripe/react-stripe-js', 'stripe/stripe-php', 'laravel/cashier', 'braintree', 'authorizenet/authorizenet', 'paypal'] },
  },
  {
    subject: 'WebSockets',
    question: 'Have you built real-time features with WebSockets?',
    terms: { code: ['websocket', 'socket.io', 'wss://', 'Pusher', 'laravel-echo', 'Reverb', 'onmessage', 'broadcast'], paths: ['/sockets/', 'channels.php', 'broadcasting.php'], packages: ['socket.io', 'socket.io-client', 'ws', 'laravel-echo', 'pusher-js', 'pusher/pusher-php-server', 'beyondcode/laravel-websockets', 'laravel/reverb'] },
  },
]

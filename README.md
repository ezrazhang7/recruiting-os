# Recruiting OS

Recruiting OS turns fragmented UNC student-organization recruiting information into current, evidence-backed applications and events. It ingests versioned evidence from approved connectors and public URLs, extracts claims, reconciles conflicts, and presents a protected student dashboard with an attributable review workflow.

## Release posture

This repository contains production-oriented application code, but a deployment is not approved merely because the code builds. A release requires the external gates in [the operations runbook](docs/RUNBOOK.md): UNC OIDC/provider credentials, managed Postgres, backups and a restore drill, monitoring/alerts, provider integration tests, and the production-equivalent [load test](docs/LOAD_TEST.md). Never deploy the development SQLite/auth mode publicly.

## Architecture

- Fastify API with deny-by-default authentication, server-side hashed sessions, CSRF protection, RBAC, organization scoping, strict request validation, CSP/CORS, bounded bodies, and sanitized errors.
- Immutable logical sources and content-addressed source versions. Failed extraction remains retryable; changed content at the same URL creates a new version; unchanged content is a no-op.
- Evidence resolver with authority/recency rules, IANA `America/New_York` time handling, date precision, policy versioning, and audited human overrides.
- Postgres production repositories with tenant RLS, migrations, encrypted connector credentials, durable fair queues, leases, retries, dead letters, cursor state, and shared rate limiting.
- Workers for bounded URL/screenshot ingestion and durable recurring Gmail, GroupMe, Instagram, and LinkedIn sync. Provider calls use host allowlists, timeouts, retry/backoff, and circuit breaking; public URL fetches revalidate DNS and every redirect against SSRF policy.
- Accessible student UI and evidence/admin controls served as same-origin assets. Student DTOs omit internal tenant and evidence data.
- Structured redacted logs, request IDs, protected Prometheus-format API/queue metrics, health/readiness probes, immutable container deployment templates, and backup/recovery runbooks.
- Versioned consent for private connectors/screenshots and an executable retention job that redacts expired private evidence and terminal job payloads.

The module direction is `domain → application ports → infrastructure adapters → bootstraps`. Domain and resolver code do not depend on Fastify, SQLite, Postgres, or provider SDKs.

## Local development

Use Node 22 LTS (see `.nvmrc`).

```bash
npm ci
cp .env.example .env
npm run check
npm run dev
```

Open `http://127.0.0.1:4318`. Local mode uses an explicit development login and SQLite. The browser interface is the normal entry point; API routes remain protected.

For a local Postgres stack:

```bash
docker compose up --build
```

This starts Postgres, applies migrations, and runs separate API and worker containers. The compose credentials are local-only.

## Production configuration

Production startup fails closed unless all of the following are set:

- `NODE_ENV=production`, `DATABASE_DRIVER=postgres`, and a TLS-capable `DATABASE_URL`.
- `AUTH_MODE=oidc`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_REDIRECT_URI`, a non-development `SESSION_SECRET`, and the permitted email domain.
- A 32-byte base64 `CREDENTIAL_MASTER_KEY` sourced from a secret manager, with a tracked key version.
- Exact `ALLOWED_ORIGINS`, trusted-proxy configuration, provider OAuth credentials/redirects, and an optional OpenAI extraction key.

See [.env.example](.env.example) for the complete contract. Do not commit `.env` or credentials.

Run migrations as a one-off release job before rolling API/worker instances:

```bash
npm run build
DATABASE_URL=postgresql://... npm run migrate
```

## Verification

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm audit --audit-level=high
TEST_DATABASE_URL=postgresql://... npm run test:postgres
```

CI repeats these checks on Node 22 and a real Postgres 16 service, proves RLS cross-tenant isolation, checks shared rate-limit atomicity, and scans the Git history for secrets. Provider contract tests use injected transports; live-provider and production load gates must run in a controlled staging account before release.

The production load harness requires 1,000 distinct short-lived sessions and exercises mixed
dashboard/ingestion traffic. See [the load-test gate](docs/LOAD_TEST.md); never commit its session
fixture.

## API surface

Public routes are limited to the UI assets, liveness/readiness, and OIDC/development-auth entry points. Authenticated routes cover the student dashboard, organizations, connector OAuth/status/revoke/sync, bounded ingestion queueing, admin evidence, reviewed opportunity overrides, and protected metrics. Mutations require CSRF and idempotent queue jobs.

## Data handling and incident response

Read [data governance](docs/DATA_GOVERNANCE.md), the [operations runbook](docs/RUNBOOK.md), and [security policy](SECURITY.md) before connecting real student accounts. Raw messages, screenshots, session data, and OAuth tokens are sensitive. Logs redact those values; connector credentials are authenticated-encrypted at rest; evidence access and material mutations are audited.

## Intentional provider constraints

LinkedIn support uses authorized organization APIs and never scrapes logged-in pages. Instagram support targets Professional-account discovery; screenshots cover Stories/personal accounts. Gmail access is read-only and bounded. Connector access depends on provider approval and must comply with provider and university policy.

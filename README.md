# Recruiting OS

Recruiting OS turns fragmented UNC student-organization recruiting information into current, evidence-backed applications and events. It ingests versioned evidence from approved connectors and public URLs, extracts claims, reconciles conflicts, and presents a protected student dashboard with an attributable review workflow.

## Release posture

This repository contains production-oriented application code, but a deployment is not approved merely because the code builds. A release requires the external gates in [the operations runbook](docs/RUNBOOK.md): UNC OIDC/provider credentials, managed Postgres, backups and a restore drill, monitoring/alerts, provider integration tests, and the production-equivalent [load test](docs/LOAD_TEST.md). Never deploy the development SQLite/auth mode publicly.

## Architecture

- Fastify API with deny-by-default authentication, server-side hashed sessions, CSRF protection, RBAC, organization scoping, strict request validation, CSP/CORS, independently bounded ordinary and screenshot bodies, and sanitized errors.
- Immutable logical sources and content-addressed source versions. Failed extraction remains retryable; changed content at the same URL creates a new version; unchanged content is a no-op.
- Evidence resolver with authority/recency rules, IANA `America/New_York` time handling, date precision, policy versioning, and audited human overrides.
- Postgres production repositories with tenant RLS, migrations, encrypted connector credentials, durable fair queues, renewable worker leases, crash recovery, retries, dead letters, cursor state, and shared rate limiting.
- Workers for bounded URL/screenshot ingestion and durable recurring Gmail, GroupMe, Instagram, and LinkedIn sync. Provider calls use host allowlists, request timeouts, bounded streamed responses, standards-correct retry/backoff, and worker-wide circuit breaking; public URL fetches revalidate DNS and every redirect against SSRF policy.
- Accessible student UI and evidence/admin controls served as same-origin assets. Student DTOs omit internal tenant and evidence data.
- Structured redacted logs, request IDs, protected Prometheus-format API/queue metrics, deployable Prometheus Operator alerts, health/readiness probes, immutable container deployment templates, and backup/recovery runbooks.
- Versioned consent for private connectors/screenshots and an executable retention policy that immediately discards terminal screenshot bytes and redacts other expired private evidence and terminal job payloads.
- User-scoped connector cursors, per-version contributor provenance, metadata-only self-service
  exports, and account erasure that deletes sole-contributor private evidence while preserving
  independently shared evidence and durably reconciling derived opportunities.

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

- `NODE_ENV=production`, `DATABASE_DRIVER=postgres`, and a TLS-required `DATABASE_URL` (prefer
  `sslmode=verify-full`) using a dedicated `NOSUPERUSER NOBYPASSRLS` runtime role. The runtime role must not own or inherit
  ownership of tenant tables; startup rejects unsafe roles.
- `DATABASE_POOL_SIZE` as the total connection budget per process; size it with the maximum API and
  worker replica count using the formula in the runbook.
- `AUTH_MODE=oidc`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_REDIRECT_URI`, a non-development
  `SESSION_SECRET` and the permitted email domain. A new empty tenant also needs one exact verified
  UNC address in `INITIAL_PLATFORM_ADMIN_EMAILS` to bootstrap the first operator; startup accepts
  an empty list only after a platform-admin membership exists.
- A 32-byte base64 `CREDENTIAL_MASTER_KEY` and a distinct 32+ character `METRICS_BEARER_TOKEN`, both sourced from a secret manager.
- Exact `ALLOWED_ORIGINS`, trusted-proxy configuration, provider OAuth credentials/redirects, and an optional OpenAI extraction key.

See [.env.example](.env.example) for the complete contract. Do not commit `.env` or credentials.
The initial-admin allowlist grants or restores `platform_admin` when that verified identity signs
in; it never revokes roles. After the named operator signs in successfully, remove the bootstrap
entry and manage membership roles through an approved operational change with an audit record.

Run migrations as a separate owner role before rolling API/worker instances. Keep that credential
disabled or inaccessible outside the release workflow, and do not use the migration owner in
`DATABASE_URL` at runtime:

```bash
npm run build
DATABASE_URL=postgresql://migration-owner@... npm run migrate
MIGRATION_DATABASE_URL=postgresql://migration-owner@... \
  RUNTIME_DATABASE_ROLE=recruiting_os_runtime npm run grant:runtime
```

The grant command refuses an owner, superuser, or RLS-bypass target, removes public schema-create
access, applies the required runtime/default privileges, and must run after each migration. Keep the
owner and runtime credentials in separate secret-manager entries. This separation lets narrowly
scoped security-definer functions perform cross-tenant session lookup, fair queue leasing, and
maintenance while ordinary runtime SQL remains constrained by RLS.

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

Public routes are limited to the UI assets, liveness/readiness, and OIDC/development-auth entry points. Authenticated routes cover the student dashboard, organizations, connector OAuth/status/revoke/sync, bounded ingestion queueing, admin evidence, reviewed opportunity overrides, and administrator metrics. The machine `/metrics` endpoint requires a constant-time-checked bearer credential. Mutations require CSRF and idempotent queue jobs.

Authenticated students can also download their metadata-only account export and request account
erasure from the privacy panel. Account deletion revokes the active session and requires explicit
confirmation plus CSRF protection.

## Data handling and incident response

Read [data governance](docs/DATA_GOVERNANCE.md), the [operations runbook](docs/RUNBOOK.md), and [security policy](SECURITY.md) before connecting real student accounts. Raw messages, screenshots, session data, and OAuth tokens are sensitive. Logs redact those values; connector credentials are authenticated-encrypted at rest; evidence access and material mutations are audited.

## Intentional provider constraints

LinkedIn support uses authorized organization APIs and never scrapes logged-in pages. Instagram support targets Professional-account discovery; screenshots cover Stories/personal accounts. Gmail access is read-only and bounded. Connector access depends on provider approval and must comply with provider and university policy.

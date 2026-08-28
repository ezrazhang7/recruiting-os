# Recruiting OS operations runbook

## Release sequence

1. Build an immutable image tagged with the reviewed commit SHA and scan it for critical/high CVEs.
2. Back up production and verify both the archive manifest and its SHA-256 sidecar.
3. Run `npm run migrate` as a one-off job. Migrations are forward-only in production.
4. Deploy one API canary, verify readiness, login, dashboard, ingestion enqueue, worker completion, and metrics.
5. Roll the API and workers. Watch error rate, p95 latency, database connections, queue age, retry rate, dead letters, and OIDC failures for 30 minutes.

`DATABASE_POOL_SIZE` is the total Postgres connection budget for one API or worker process; all
adapters in that process share it. Set the managed database connection limit above
`(maximum API replicas + worker replicas) * DATABASE_POOL_SIZE`, plus migration, maintenance,
backup, monitoring, and operator headroom. The supplied manifest budgets 72 steady application
connections: `(10 API + 2 workers) * 6`. Alert before 80% of the managed limit, and do not increase
replicas or pool size independently without recalculating this ceiling.

Workers renew their lease while processing long jobs. A crashed worker's expired job is reclaimed by
another worker until its configured final attempt, when it is dead-lettered. During a rollout, allow
the configured 120-second termination grace period before forcefully terminating a worker.

`/health/live` proves only that the API process can answer; it deliberately bypasses external
dependencies so a database outage does not cause a restart loop. `/health/ready` checks the
repository and durable queue and removes an unhealthy pod from service. Probe routes bypass public
rate limiting so infrastructure checks cannot throttle one another.

Rollback the application by restoring the previous immutable image. Do not run down migrations on production data. If a migration is incompatible, deploy a forward repair migration. Stop workers before a data restore.

## Alerts and first response

Page the on-call engineer for: readiness failing for 5 minutes; HTTP 5xx above 2% for 10 minutes; p95 latency above 2 seconds; oldest ready job above 5 minutes; any dead-letter growth; database storage above 80%; backup older than 26 hours; or OIDC callback failures above 5%.

First response: declare the incident, preserve request IDs and sanitized logs, stop ingestion workers if they amplify damage, verify database health and provider status, then choose rollback or forward repair. Never paste access tokens, screenshot contents, raw recruiting messages, or session cookies into incident chat.

Prometheus alert inputs include:

```promql
histogram_quantile(0.95, sum by (le) (rate(recruiting_os_http_request_duration_ms_bucket[5m])))
sum(rate(recruiting_os_http_requests_total{status=~"5.."}[10m])) / sum(rate(recruiting_os_http_requests_total[10m]))
sum(rate(recruiting_os_http_requests_total{route="_auth_callback",status!~"2..|3.."}[10m])) / sum(rate(recruiting_os_http_requests_total{route="_auth_callback"}[10m]))
```

Configure the scraper to request `/metrics` with `Authorization: Bearer
$METRICS_BEARER_TOKEN`, sourced from the production secret manager. It must not reuse a user session
or connector token. Rotate this credential and validate that unauthenticated and stale credentials
receive HTTP 401.

Alert rules must also consume the exported queue gauges and the managed database, backup, and
container-memory metrics. Validate each rule with a synthetic failure before release.

## Backup and recovery

Create encrypted daily Postgres snapshots with 35-day retention and weekly cross-region copies. Quarterly, restore the latest backup into an isolated account, run migrations, compare tenant/source/claim/job counts, exercise a student login and dashboard query, and record achieved RPO/RTO. Target RPO is 24 hours and target RTO is 4 hours. The repository's logical dump and SHA-256 sidecar must be created only on an encrypted volume; the sidecar proves integrity, not confidentiality.

For a restore: disable API writes and workers, create a fresh empty database, and run
`BACKUP_FILE=... DATABASE_URL=... RESTORE_CONFIRM=RESTORE_TO_EMPTY_DATABASE scripts/restore.sh`.
The script verifies the SHA-256 sidecar and restores in one transaction. Rotate database
credentials, run smoke tests, then re-enable the API before workers. Keep the damaged database
read-only until the incident review closes. CI performs the same backup/restore round trip and
compares core table counts on every change; the quarterly managed-environment drill remains a
release gate.

## Security operations

Rotate the session secret and credential encryption key through the secret manager. Key rotation is staged: deploy support for the new key version, re-encrypt credentials, verify counts, then retire the previous key. Revoke a connector through the API and at the provider. Audit evidence reads, organization changes, connector lifecycle actions, and ingestion queue actions.

The Kubernetes maintenance CronJob runs `npm run maintenance` daily. Alert when it misses two runs
or fails. It redacts raw private source versions after 90 days and terminal job payloads after 30
days, clears expired sessions/rate-limit buckets, deletes credentials revoked for 30 days, and
retains audit events for 365 days. Investigate all SSRF blocks and repeated cross-tenant
authorization failures.

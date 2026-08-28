# Recruiting OS operations runbook

## Release sequence

1. Build an immutable image tagged with the reviewed commit SHA and scan it for critical/high CVEs.
2. Back up production and verify the archive with `pg_restore --list`.
3. Run `npm run migrate` as a one-off job. Migrations are forward-only in production.
4. Deploy one API canary, verify readiness, login, dashboard, ingestion enqueue, worker completion, and metrics.
5. Roll the API and workers. Watch error rate, p95 latency, database connections, queue age, retry rate, dead letters, and OIDC failures for 30 minutes.

Workers renew their lease while processing long jobs. A crashed worker's expired job is reclaimed by
another worker until its configured final attempt, when it is dead-lettered. During a rollout, allow
the configured 120-second termination grace period before forcefully terminating a worker.

Rollback the application by restoring the previous immutable image. Do not run down migrations on production data. If a migration is incompatible, deploy a forward repair migration. Stop workers before a data restore.

## Alerts and first response

Page the on-call engineer for: readiness failing for 5 minutes; HTTP 5xx above 2% for 10 minutes; p95 latency above 2 seconds; oldest ready job above 5 minutes; any dead-letter growth; database storage above 80%; backup older than 26 hours; or OIDC callback failures above 5%.

First response: declare the incident, preserve request IDs and sanitized logs, stop ingestion workers if they amplify damage, verify database health and provider status, then choose rollback or forward repair. Never paste access tokens, screenshot contents, raw recruiting messages, or session cookies into incident chat.

## Backup and recovery

Create encrypted daily Postgres snapshots with 35-day retention and weekly cross-region copies. Quarterly, restore the latest backup into an isolated account, run migrations, compare tenant/source/claim/job counts, exercise a student login and dashboard query, and record achieved RPO/RTO. Target RPO is 24 hours and target RTO is 4 hours.

For a restore: disable API writes and workers, create a fresh database, run `BACKUP_FILE=... DATABASE_URL=... scripts/restore.sh`, rotate database credentials, run smoke tests, then re-enable the API before workers. Keep the damaged database read-only until the incident review closes.

## Security operations

Rotate the session secret and credential encryption key through the secret manager. Key rotation is staged: deploy support for the new key version, re-encrypt credentials, verify counts, then retire the previous key. Revoke a connector through the API and at the provider. Audit evidence reads, organization changes, connector lifecycle actions, and ingestion queue actions.

The Kubernetes maintenance CronJob runs `npm run maintenance` daily. Alert when it misses two runs
or fails. It redacts raw private source versions after 90 days and terminal job payloads after 30
days, clears expired sessions/rate-limit buckets, deletes credentials revoked for 30 days, and
retains audit events for 365 days. Investigate all SSRF blocks and repeated cross-tenant
authorization failures.

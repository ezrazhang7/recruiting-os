# Security policy

Do not open a public issue containing a vulnerability, student data, credentials, request headers, screenshots, or recruiting-message contents. Report vulnerabilities privately through GitHub Security Advisories for this repository.

Supported releases are immutable commit-tagged images currently deployed to production. Security fixes are applied to the current release line; there is no promise of support for older source snapshots.

Reports should include the affected commit, impact, minimal reproduction using synthetic data, and suggested remediation. Remove tokens and personal data. Maintainers should acknowledge a report within two business days, establish severity and containment, rotate exposed credentials immediately, and coordinate disclosure after a fix is deployed.

The application must run behind TLS with managed Postgres, OIDC, a secret manager, tenant RLS, backups, monitoring, and the controls described in `docs/RUNBOOK.md`. Postgres migrations and runtime use separate roles; the runtime role is a non-owner with `NOSUPERUSER NOBYPASSRLS`. Development authentication and SQLite are not production-supported.

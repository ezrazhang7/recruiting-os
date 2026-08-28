# Load-test gate

Run the API and workers against an isolated Postgres database containing at least 250 organizations and 10,000 opportunities. Exercise 1,000 authenticated student sessions with a realistic ramp, 25 dashboard requests per second, and 5 ingestion jobs per second for 30 minutes.

Release gates: no cross-tenant response data; no lost or duplicated source versions; zero unhandled errors; HTTP 5xx below 0.5%; dashboard p95 below 750 ms and p99 below 1.5 seconds; ingestion enqueue p95 below 500 ms; oldest queued job below 2 minutes after the ramp; database pool saturation below 80%; and memory returning to within 15% of baseline after the test.

Use production-equivalent limits and outbound-provider fakes. A load test must never call live Gmail, GroupMe, Meta, LinkedIn, or OpenAI accounts.

## Harness

Create a local, ignored JSON file containing at least 1,000 distinct staging sessions. Never commit
this file:

```json
[
  {
    "cookie": "recruiting_session=REDACTED",
    "organizationIdPrefix": "unc-load-",
    "csrfToken": "REDACTED",
    "ingestionOrganizationId": "unc-load-editor-org",
    "admin": true
  }
]
```

Every fixture needs the organization prefix assigned to its tenant so the harness can fail on a
cross-tenant response. At least one editor/admin fixture needs a CSRF token and ingestion
organization, and one fixture must be marked `admin` so queue metrics can be checked. Generate
these short-lived sessions through the staging identity setup; revoke them after the run.

Run the default 30-minute test:

```bash
LOAD_TEST_BASE_URL=https://staging.example.edu \
LOAD_TEST_SESSIONS_FILE=./load-test-sessions.staging.json \
LOAD_TEST_INGEST_URL=https://provider-fake.staging.example.edu/recruiting \
npm run test:load
```

The harness ramps all supplied sessions over five minutes, then sustains 25 dashboard requests and
5 ingestion requests per second. It fails on cross-tenant organization IDs, latency/error
thresholds, new dead letters, or a ready-job age of two minutes after the drain window. It refuses
known live-provider hosts and never prints session credentials.

Use the staging monitoring system to record database-pool saturation and process/container memory;
those are infrastructure signals and are not inferred from client timing. Save the harness JSON
report and monitoring dashboard snapshot with the release record.

# Load-test gate

Run the API and workers against an isolated Postgres database containing at least 250 organizations and 10,000 opportunities. Exercise 1,000 authenticated student sessions with a realistic ramp, 25 dashboard requests per second, and 5 ingestion jobs per second for 30 minutes.

Release gates: no cross-tenant response data; no lost or duplicated source versions; zero unhandled errors; HTTP 5xx below 0.5%; dashboard p95 below 750 ms and p99 below 1.5 seconds; ingestion enqueue p95 below 500 ms; oldest queued job below 2 minutes after the ramp; database pool saturation below 80%; and memory returning to within 15% of baseline after the test.

Use production-equivalent limits and outbound-provider fakes. A load test must never call live Gmail, GroupMe, Meta, LinkedIn, or OpenAI accounts.

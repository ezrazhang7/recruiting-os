import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

interface SessionFixture {
  cookie: string;
  csrfToken?: string;
  organizationIdPrefix: string;
  ingestionOrganizationId?: string;
  admin?: boolean;
}

interface RequestSamples {
  durations: number[];
  failures: number;
  serverErrors: number;
  completed: number;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveNumber(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

export function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.ceil(ordered.length * fraction) - 1] ?? 0;
}

export function metricValue(text: string, name: string, labels = ''): number {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const labelPattern = labels ? `\\{${labels.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}` : '';
  const match = text.match(new RegExp(`^${escaped}${labelPattern}\\s+([0-9.eE+-]+)$`, 'm'));
  return match ? Number(match[1]) : 0;
}

async function main(): Promise<void> {
  const baseUrl = new URL(requiredEnvironment('LOAD_TEST_BASE_URL'));
  const sessionFile = requiredEnvironment('LOAD_TEST_SESSIONS_FILE');
  const ingestionUrl = new URL(requiredEnvironment('LOAD_TEST_INGEST_URL'));
  const durationSeconds = positiveNumber('LOAD_TEST_DURATION_SECONDS', 1_800);
  const rampSeconds = positiveNumber('LOAD_TEST_RAMP_SECONDS', 300);
  const dashboardRps = positiveNumber('LOAD_TEST_DASHBOARD_RPS', 25);
  const ingestionRps = positiveNumber('LOAD_TEST_INGESTION_RPS', 5);
  const maxInFlight = positiveNumber('LOAD_TEST_MAX_IN_FLIGHT', 250);
  const drainSeconds = positiveNumber('LOAD_TEST_DRAIN_SECONDS', 600);
  const minimumSessions = positiveNumber('LOAD_TEST_MIN_SESSIONS', 1_000);
  if (durationSeconds <= rampSeconds)
    throw new Error('LOAD_TEST_DURATION_SECONDS must exceed the ramp duration');
  if (baseUrl.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(baseUrl.hostname))
    throw new Error('LOAD_TEST_BASE_URL must use HTTPS outside localhost');
  if (/(google|groupme|facebook|instagram|linkedin|openai)/i.test(ingestionUrl.hostname))
    throw new Error('LOAD_TEST_INGEST_URL must point to an outbound-provider fake');

  const sessions = JSON.parse(await readFile(sessionFile, 'utf8')) as SessionFixture[];
  assert.ok(Array.isArray(sessions), 'Session fixture must be a JSON array');
  assert.ok(
    sessions.length >= minimumSessions,
    `At least ${minimumSessions} sessions are required`,
  );
  assert.equal(new Set(sessions.map((session) => session.cookie)).size, sessions.length);
  for (const session of sessions) {
    assert.ok(session.cookie, 'Every session requires a cookie');
    assert.ok(session.organizationIdPrefix, 'Every session requires an organizationIdPrefix');
  }
  const ingestionSessions = sessions.filter(
    (session) => session.csrfToken && session.ingestionOrganizationId,
  );
  assert.ok(ingestionSessions.length > 0, 'At least one ingestion-capable session is required');
  const adminSession = sessions.find((session) => session.admin);
  assert.ok(adminSession, 'An admin session is required for queue gate verification');
  const estimatedDashboardRequests =
    dashboardRps * (durationSeconds - rampSeconds + rampSeconds / 2);
  assert.ok(
    estimatedDashboardRequests >= sessions.length,
    'The configured duration/rate cannot exercise every supplied session',
  );

  const dashboard: RequestSamples = { durations: [], failures: 0, serverErrors: 0, completed: 0 };
  const ingestion: RequestSamples = { durations: [], failures: 0, serverErrors: 0, completed: 0 };
  const sessionsExercised = new Set<string>();
  let isolationViolations = 0;
  const pending = new Set<Promise<void>>();

  const enqueue = async (operation: () => Promise<void>): Promise<void> => {
    while (pending.size >= maxInFlight) await Promise.race(pending);
    const task = operation();
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
  };

  const record = async (
    samples: RequestSamples,
    operation: () => Promise<Response>,
    inspect?: (response: Response) => Promise<void>,
  ): Promise<void> => {
    const started = performance.now();
    try {
      const response = await operation();
      if (response.status >= 500) samples.serverErrors += 1;
      if (!response.ok) {
        samples.failures += 1;
        await response.arrayBuffer();
      } else if (inspect) await inspect(response);
      else await response.arrayBuffer();
    } catch {
      samples.failures += 1;
    } finally {
      samples.completed += 1;
      samples.durations.push(performance.now() - started);
    }
  };

  const runStream = async (
    rate: number,
    selectSession: (sequence: number, activeSessions: number) => SessionFixture,
    operation: (session: SessionFixture) => Promise<void>,
  ): Promise<void> => {
    const started = performance.now();
    const intervalMs = 1_000 / rate;
    let nextAt = started;
    let sequence = 0;
    while (performance.now() - started < durationSeconds * 1_000) {
      const elapsedSeconds = (performance.now() - started) / 1_000;
      const rampFraction = Math.min(1, elapsedSeconds / rampSeconds);
      if (Math.random() <= rampFraction) {
        const activeSessions = Math.max(1, Math.floor(sessions.length * rampFraction));
        const session = selectSession(sequence, activeSessions);
        sessionsExercised.add(session.cookie);
        await enqueue(() => operation(session));
        sequence += 1;
      }
      nextAt += intervalMs;
      const waitMs = nextAt - performance.now();
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  };

  const fetchMetrics = async (): Promise<string> => {
    const response = await fetch(new URL('/api/admin/metrics', baseUrl), {
      headers: { cookie: adminSession.cookie },
    });
    assert.equal(response.status, 200, 'Admin metrics must be available during the load test');
    return response.text();
  };
  const baselineMetrics = await fetchMetrics();
  const baselineDeadLetters = metricValue(
    baselineMetrics,
    'recruiting_os_jobs',
    'status="dead_letter"',
  );

  await Promise.all([
    runStream(
      dashboardRps,
      (sequence, activeSessions) => sessions[sequence % activeSessions]!,
      async (session) =>
        record(
          dashboard,
          () =>
            fetch(new URL('/api/dashboard', baseUrl), {
              headers: { cookie: session.cookie },
            }),
          async (response) => {
            const body = (await response.json()) as { organizations?: Array<{ id?: string }> };
            const organizations = body.organizations ?? [];
            if (
              organizations.some(
                (organization) =>
                  !organization.id || !organization.id.startsWith(session.organizationIdPrefix),
              )
            )
              isolationViolations += 1;
          },
        ),
    ),
    runStream(
      ingestionRps,
      (sequence) => ingestionSessions[sequence % ingestionSessions.length]!,
      async (session) =>
        record(ingestion, () =>
          fetch(new URL('/api/ingest/url', baseUrl), {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              cookie: session.cookie,
              'x-csrf-token': session.csrfToken!,
              'x-idempotency-key': randomUUID(),
            },
            body: JSON.stringify({
              organizationId: session.ingestionOrganizationId,
              url: ingestionUrl.toString(),
            }),
          }),
        ),
    ),
  ]);
  await Promise.all(pending);

  const drainDeadline = Date.now() + drainSeconds * 1_000;
  let finalMetrics = await fetchMetrics();
  while (
    metricValue(finalMetrics, 'recruiting_os_oldest_ready_job_age_seconds') >= 120 &&
    Date.now() < drainDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    finalMetrics = await fetchMetrics();
  }

  const totalCompleted = dashboard.completed + ingestion.completed;
  const totalFailures = dashboard.failures + ingestion.failures;
  const totalServerErrors = dashboard.serverErrors + ingestion.serverErrors;
  const report = {
    configuredSessions: sessions.length,
    sessionsExercised: sessionsExercised.size,
    durationSeconds,
    rampSeconds,
    dashboard: {
      requests: dashboard.completed,
      failures: dashboard.failures,
      p50Ms: percentile(dashboard.durations, 0.5),
      p95Ms: percentile(dashboard.durations, 0.95),
      p99Ms: percentile(dashboard.durations, 0.99),
    },
    ingestion: {
      requests: ingestion.completed,
      failures: ingestion.failures,
      p50Ms: percentile(ingestion.durations, 0.5),
      p95Ms: percentile(ingestion.durations, 0.95),
      p99Ms: percentile(ingestion.durations, 0.99),
    },
    failureRate: totalFailures / totalCompleted,
    serverErrorRate: totalServerErrors / totalCompleted,
    isolationViolations,
    deadLetterDelta:
      metricValue(finalMetrics, 'recruiting_os_jobs', 'status="dead_letter"') - baselineDeadLetters,
    oldestReadyJobAgeSeconds: metricValue(
      finalMetrics,
      'recruiting_os_oldest_ready_job_age_seconds',
    ),
  };
  console.log(JSON.stringify(report));
  assert.equal(report.sessionsExercised, sessions.length, 'Not every session was exercised');
  assert.equal(report.isolationViolations, 0, 'Cross-tenant organization data was observed');
  assert.ok(report.failureRate < 0.005, `Failure rate ${report.failureRate} exceeded 0.5%`);
  assert.ok(report.serverErrorRate < 0.005, `5xx rate ${report.serverErrorRate} exceeded 0.5%`);
  assert.ok(
    report.dashboard.p95Ms < 750,
    `Dashboard p95 ${report.dashboard.p95Ms}ms exceeded 750ms`,
  );
  assert.ok(
    report.dashboard.p99Ms < 1_500,
    `Dashboard p99 ${report.dashboard.p99Ms}ms exceeded 1.5s`,
  );
  assert.ok(
    report.ingestion.p95Ms < 500,
    `Ingestion p95 ${report.ingestion.p95Ms}ms exceeded 500ms`,
  );
  assert.equal(report.deadLetterDelta, 0, 'Dead-letter jobs increased during the test');
  assert.ok(
    report.oldestReadyJobAgeSeconds < 120,
    'The queue did not recover below two minutes after load',
  );
}

if (require.main === module) void main();

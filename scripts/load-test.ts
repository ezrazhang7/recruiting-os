import assert from 'node:assert/strict';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
const baseUrl = requiredEnvironment('LOAD_TEST_BASE_URL');
const cookie = requiredEnvironment('LOAD_TEST_SESSION_COOKIE');
const requests = Number(process.env.LOAD_TEST_REQUESTS ?? 45_000);
const concurrency = Number(process.env.LOAD_TEST_CONCURRENCY ?? 100);
const durations: number[] = [];
let failures = 0;
let cursor = 0;

async function client(): Promise<void> {
  while (true) {
    const index = cursor;
    cursor += 1;
    if (index >= requests) return;
    const started = performance.now();
    try {
      const response = await fetch(`${baseUrl}/api/dashboard`, { headers: { cookie } });
      if (!response.ok) failures += 1;
      await response.arrayBuffer();
    } catch {
      failures += 1;
    }
    durations.push(performance.now() - started);
  }
}

async function main(): Promise<void> {
  await Promise.all(Array.from({ length: concurrency }, () => client()));
  durations.sort((a, b) => a - b);
  const percentile = (value: number) => durations[Math.ceil(durations.length * value) - 1] ?? 0;
  const report = {
    requests,
    concurrency,
    failures,
    failureRate: failures / requests,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
  };
  console.log(JSON.stringify(report));
  assert.ok(report.failureRate < 0.005, `Failure rate ${report.failureRate} exceeded 0.5%`);
  assert.ok(report.p95Ms < 750, `p95 ${report.p95Ms}ms exceeded 750ms`);
}

void main();

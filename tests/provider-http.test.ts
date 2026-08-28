import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ProviderHttpClient,
  retryDelayMs,
} from '../src/infrastructure/outbound-http/provider-http-client';

test('provider Retry-After seconds are honored in milliseconds', async () => {
  const delays: number[] = [];
  let attempts = 0;
  const client = new ProviderHttpClient({
    allowedHosts: new Set(['api.example.com']),
    transport: (async () => {
      attempts += 1;
      return attempts === 1
        ? new Response('busy', { status: 429, headers: { 'retry-after': '2' } })
        : new Response('ok');
    }) as typeof fetch,
    sleep: async (milliseconds) => {
      delays.push(milliseconds);
    },
  });

  const response = await client.fetch('https://api.example.com/data');
  assert.equal(await response.text(), 'ok');
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [2_000]);
});

test('provider responses are rejected when declared or streamed content exceeds the cap', async () => {
  let attempts = 0;
  const declared = new ProviderHttpClient({
    allowedHosts: new Set(['api.example.com']),
    maxResponseBytes: 5,
    transport: (async () => {
      attempts += 1;
      return new Response('0123456789', { headers: { 'content-length': '10' } });
    }) as typeof fetch,
  });
  await assert.rejects(() => declared.fetch('https://api.example.com/data'), /size limit/);
  assert.equal(attempts, 1);

  const streamed = new ProviderHttpClient({
    allowedHosts: new Set(['api.example.com']),
    maxAttempts: 1,
    maxResponseBytes: 5,
    transport: (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('123'));
            controller.enqueue(new TextEncoder().encode('456'));
            controller.close();
          },
        }),
      )) as typeof fetch,
  });
  await assert.rejects(() => streamed.fetch('https://api.example.com/data'), /size limit/);
});

test('provider retry delay supports HTTP dates and bounded exponential fallback', () => {
  const now = Date.parse('2026-08-28T12:00:00Z');
  assert.equal(retryDelayMs('Fri, 28 Aug 2026 12:00:03 GMT', 1, now), 3_000);
  assert.equal(retryDelayMs(null, 3, now), 1_000);
  assert.equal(retryDelayMs('60', 1, now), 5_000);
});

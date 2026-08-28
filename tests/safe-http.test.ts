import assert from 'node:assert/strict';
import test from 'node:test';
import { SafeHttpClient } from '../src/infrastructure/outbound-http/safe-http-client';
import { isPublicIp, resolvePublicHttpTarget } from '../src/url';

test('private, metadata, mapped, documentation, and carrier NAT IPs are blocked', () => {
  for (const address of [
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '100.64.0.1',
    '192.0.2.1',
    '198.51.100.1',
    '203.0.113.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
  ])
    assert.equal(isPublicIp(address), false, address);
  assert.equal(isPublicIp('8.8.8.8'), true);
  assert.equal(isPublicIp('2606:4700:4700::1111'), true);
});

test('unsafe schemes, credentials, and ports are rejected', async () => {
  await assert.rejects(() => resolvePublicHttpTarget('file:///etc/passwd'), /http/);
  await assert.rejects(
    () => resolvePublicHttpTarget('https://user:pass@example.com'),
    /Credentialed/,
  );
  await assert.rejects(() => resolvePublicHttpTarget('http://8.8.8.8:8080'), /port/);
  await assert.rejects(() => resolvePublicHttpTarget('http://127.0.0.1'), /non-public/);
});

test('every redirect hop is resolved and revalidated', async () => {
  const resolved: string[] = [];
  const responses = [
    new Response(null, { status: 302, headers: { location: 'https://second.example/path' } }),
    new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }),
  ];
  const client = new SafeHttpClient({
    resolver: async (raw) => {
      resolved.push(raw);
      return { url: new URL(raw), addresses: [{ address: '8.8.8.8', family: 4 }] };
    },
    transport: (async () => responses.shift()!) as any,
  });
  const response = await client.fetch('https://first.example');
  assert.equal(await response.text(), 'ok');
  assert.deepEqual(resolved, ['https://first.example/', 'https://second.example/path']);
});

test('streamed response bodies are capped', async () => {
  const client = new SafeHttpClient({
    maxResponseBytes: 3,
    resolver: async (raw) => ({
      url: new URL(raw),
      addresses: [{ address: '8.8.8.8', family: 4 }],
    }),
    transport: (async () => new Response('four')) as any,
  });
  await assert.rejects(() => client.fetch('https://example.com'), /size limit/);
});

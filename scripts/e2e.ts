import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('No test port'));
      server.close(() => resolve(address.port));
    });
  });
}

async function waitUntilReady(baseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/health/ready`)).ok) return;
    } catch {
      // The process may still be binding its socket.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('API did not become ready');
}

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'recruiting-os-e2e-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--experimental-sqlite', 'dist/src/bootstrap/api.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      DATABASE_DRIVER: 'sqlite',
      DATABASE_PATH: join(directory, 'e2e.sqlite'),
      AUTH_MODE: 'development',
      SESSION_SECRET: 'e2e-session-secret-that-is-long-enough',
      OIDC_ALLOWED_EMAIL_DOMAIN: 'unc.edu',
      DEFAULT_TENANT_ID: 'unc',
      LOG_LEVEL: 'silent',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  try {
    await waitUntilReady(baseUrl);
    const page = await fetch(baseUrl);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Find the right club before the deadline/);

    const login = await fetch(`${baseUrl}/auth/development`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'e2e@unc.edu', displayName: 'E2E Reviewer' }),
    });
    assert.equal(login.status, 200);
    const body = (await login.json()) as { csrfToken: string };
    const setCookies = (
      login.headers as Headers & { getSetCookie?: () => string[] }
    ).getSetCookie?.() ?? [login.headers.get('set-cookie') ?? ''];
    const cookie = setCookies
      .map((value) => value.split(';')[0])
      .filter(Boolean)
      .join('; ');
    assert.match(cookie, /recruiting_session=/);

    const created = await fetch(`${baseUrl}/api/organizations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        'x-csrf-token': body.csrfToken,
      },
      body: JSON.stringify({ id: 'e2e-club', name: 'E2E Club', school: 'UNC' }),
    });
    assert.equal(created.status, 201, await created.text());
    const dashboard = await fetch(`${baseUrl}/api/dashboard`, { headers: { cookie } });
    assert.equal(dashboard.status, 200);
    assert.equal(((await dashboard.json()) as any).organizations[0].name, 'E2E Club');
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    await rm(directory, { recursive: true, force: true });
  }
}

void main();

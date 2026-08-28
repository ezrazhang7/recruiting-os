import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionService } from '../src/application/auth/session-service';
import { loadConfig } from '../src/config/env';
import { buildApp } from '../src/http/app';
import { SqliteAuthRepository } from '../src/infrastructure/auth/sqlite-auth-repository';
import { InMemoryRateLimiter } from '../src/infrastructure/rate-limit/in-memory-rate-limiter';
import { SqliteJobQueue } from '../src/infrastructure/queue/sqlite-job-queue';
import { Store } from '../src/store';

async function fixture() {
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'development',
    DEFAULT_TENANT_ID: 'unc',
    OIDC_ALLOWED_EMAIL_DOMAIN: 'unc.edu',
    SESSION_SECRET: 'x'.repeat(32),
    LOG_LEVEL: 'silent',
  });
  const store = new Store(':memory:', 'unc');
  const auth = new SqliteAuthRepository(store);
  const queue = new SqliteJobQueue(store);
  const sessions = new SessionService(auth, 3600);
  const app = await buildApp({
    config,
    repository: store,
    queue,
    sessionService: sessions,
    rateLimiter: new InMemoryRateLimiter(),
  });
  return { app, store };
}

async function login(app: Awaited<ReturnType<typeof buildApp>>) {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/development',
    payload: { email: 'student@unc.edu', displayName: 'Student' },
  });
  assert.equal(response.statusCode, 200, response.body);
  const csrf = (response.json() as { csrfToken: string }).csrfToken;
  const setCookie = response.headers['set-cookie'];
  const values = Array.isArray(setCookie) ? setCookie : [setCookie!];
  const cookie = values.map((value) => value.split(';')[0]).join('; ');
  return { cookie, csrf };
}

test('protected API routes reject anonymous requests', async () => {
  const { app, store } = await fixture();
  const response = await app.inject({ url: '/api/dashboard' });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, 'AUTHENTICATION_REQUIRED');
  await app.close();
  await store.close();
});

test('student interface and same-origin assets are publicly renderable', async () => {
  const { app, store } = await fixture();
  const page = await app.inject({ url: '/' });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Find the right club before the deadline/);
  assert.match(page.headers['content-security-policy'] ?? '', /script-src 'self'/);
  assert.equal((await app.inject({ url: '/assets/app.js' })).statusCode, 200);
  assert.equal((await app.inject({ url: '/assets/app.css' })).statusCode, 200);
  await app.close();
  await store.close();
});

test('authenticated mutations require CSRF and enqueue bounded work', async () => {
  const { app, store } = await fixture();
  const { cookie, csrf } = await login(app);
  const denied = await app.inject({
    method: 'POST',
    url: '/api/organizations',
    headers: { cookie },
    payload: { id: 'club', name: 'Club', school: 'UNC' },
  });
  assert.equal(denied.statusCode, 403);
  const created = await app.inject({
    method: 'POST',
    url: '/api/organizations',
    headers: { cookie, 'x-csrf-token': csrf },
    payload: { id: 'club', name: 'Club', school: 'UNC' },
  });
  assert.equal(created.statusCode, 201, created.body);
  const queued = await app.inject({
    method: 'POST',
    url: '/api/ingest/url',
    headers: { cookie, 'x-csrf-token': csrf },
    payload: { organizationId: 'club', url: 'https://example.com/apply' },
  });
  assert.equal(queued.statusCode, 202, queued.body);
  assert.match(queued.json().jobId, /^job_/);
  await app.close();
  await store.close();
});

test('student dashboard DTO excludes tenant and evidence fields', async () => {
  const { app, store } = await fixture();
  const { cookie, csrf } = await login(app);
  await app.inject({
    method: 'POST',
    url: '/api/organizations',
    headers: { cookie, 'x-csrf-token': csrf },
    payload: { id: 'club', name: 'Club', school: 'UNC' },
  });
  const response = await app.inject({ url: '/api/dashboard', headers: { cookie } });
  assert.equal(response.statusCode, 200);
  const organization = response.json().organizations[0];
  assert.equal(organization.id, 'club');
  assert.equal('tenantId' in organization, false);
  assert.equal('claims' in organization, false);
  await app.close();
  await store.close();
});

test('screenshots are rejected when bytes do not match the declared MIME type', async () => {
  const { app, store } = await fixture();
  const { cookie, csrf } = await login(app);
  await app.inject({
    method: 'POST',
    url: '/api/organizations',
    headers: { cookie, 'x-csrf-token': csrf },
    payload: { id: 'club', name: 'Club', school: 'UNC' },
  });
  const response = await app.inject({
    method: 'POST',
    url: '/api/ingest/screenshot',
    headers: { cookie, 'x-csrf-token': csrf },
    payload: {
      organizationId: 'club',
      base64: Buffer.from('not an image').toString('base64'),
      mimeType: 'image/png',
    },
  });
  assert.equal(response.statusCode, 422);
  assert.equal(response.json().error.code, 'VALIDATION_FAILED');
  await app.close();
  await store.close();
});

test('organization editors cannot read another organization evidence', async () => {
  const { app, store } = await fixture();
  const { cookie, csrf } = await login(app);
  await store.upsertOrganization({ id: 'org-a', name: 'A', school: 'UNC' }, 'unc');
  await store.upsertOrganization({ id: 'org-b', name: 'B', school: 'UNC' }, 'unc');
  const user = store.db.prepare("select id from users where email='student@unc.edu'").get() as {
    id: string;
  };
  store.db
    .prepare('update memberships set roles=?,organization_ids=? where tenant_id=? and user_id=?')
    .run(JSON.stringify(['organization_editor']), JSON.stringify(['org-a']), 'unc', user.id);
  const allowed = await app.inject({
    url: '/api/admin/organizations/org-a/evidence',
    headers: { cookie },
  });
  assert.equal(allowed.statusCode, 200);
  const denied = await app.inject({
    url: '/api/admin/organizations/org-b/evidence',
    headers: { cookie },
  });
  assert.equal(denied.statusCode, 403);
  const mutate = await app.inject({
    method: 'POST',
    url: '/api/organizations',
    headers: { cookie, 'x-csrf-token': csrf },
    payload: { id: 'org-c', name: 'C', school: 'UNC' },
  });
  assert.equal(mutate.statusCode, 403);
  await app.close();
  await store.close();
});

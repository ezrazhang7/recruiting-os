import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionService } from '../src/application/auth/session-service';
import { loadConfig } from '../src/config/env';
import { buildApp } from '../src/http/app';
import { SqliteAuthRepository } from '../src/infrastructure/auth/sqlite-auth-repository';
import { InMemoryRateLimiter } from '../src/infrastructure/rate-limit/in-memory-rate-limiter';
import { SqliteJobQueue } from '../src/infrastructure/queue/sqlite-job-queue';
import { Store } from '../src/store';
import { EncryptedCredentialVault } from '../src/infrastructure/credentials/encrypted-credential-vault';
import { SqliteCredentialRepository } from '../src/infrastructure/credentials/sqlite-credential-repository';
import { ProviderOAuthService } from '../src/infrastructure/auth/provider-oauth-service';

async function fixture(overrides: NodeJS.ProcessEnv = {}) {
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'development',
    DEFAULT_TENANT_ID: 'unc',
    OIDC_ALLOWED_EMAIL_DOMAIN: 'unc.edu',
    SESSION_SECRET: 'x'.repeat(32),
    LOG_LEVEL: 'silent',
    ...overrides,
  });
  const store = new Store(':memory:', 'unc');
  const auth = new SqliteAuthRepository(store);
  const queue = new SqliteJobQueue(store);
  const credentialVault = new EncryptedCredentialVault(
    new SqliteCredentialRepository(store),
    config.auth.credentialMasterKey,
    config.auth.credentialKeyVersion,
  );
  const sessions = new SessionService(auth, 3600);
  const app = await buildApp({
    config,
    repository: store,
    queue,
    sessionService: sessions,
    rateLimiter: new InMemoryRateLimiter(),
    credentialVault,
    providerOAuth: new ProviderOAuthService({
      gmail: {
        clientId: 'test-client',
        clientSecret: 'test-secret',
        redirectUri: 'https://app.example/api/connectors/gmail/callback',
      },
    }),
  });
  return { app, store, credentialVault };
}

async function login(app: Awaited<ReturnType<typeof buildApp>>, email = 'student@unc.edu') {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/development',
    payload: { email, displayName: 'Student' },
  });
  assert.equal(response.statusCode, 200, response.body);
  const csrf = (response.json() as { csrfToken: string }).csrfToken;
  const setCookie = response.headers['set-cookie'];
  const values = Array.isArray(setCookie) ? setCookie : [setCookie!];
  const cookie = values.map((value) => value.split(';')[0]).join('; ');
  return { cookie, csrf };
}

test('local same-origin browser requests are accepted while foreign origins are rejected', async () => {
  const { app, store } = await fixture();
  const accepted = await app.inject({
    method: 'POST',
    url: '/auth/development',
    headers: { origin: 'http://127.0.0.1:4318' },
    payload: { email: 'browser@unc.edu', displayName: 'Browser' },
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  const rejected = await app.inject({
    method: 'POST',
    url: '/auth/development',
    headers: { origin: 'https://evil.example' },
    payload: { email: 'browser@unc.edu', displayName: 'Browser' },
  });
  assert.equal(rejected.statusCode, 403);
  assert.equal(rejected.json().error.code, 'ORIGIN_NOT_ALLOWED');
  await app.close();
  await store.close();
});

test('authenticated users behind one NAT are limited per user, not by the anonymous IP ceiling', async () => {
  const { app, store } = await fixture({
    RATE_LIMIT_PER_MINUTE: '2',
    AUTH_IP_RATE_LIMIT_PER_MINUTE: '100',
    AUTHENTICATED_IP_RATE_LIMIT_PER_MINUTE: '100',
  });
  const first = await login(app, 'first@unc.edu');
  const second = await login(app, 'second@unc.edu');
  assert.equal(
    (await app.inject({ url: '/api/dashboard', headers: { cookie: first.cookie } })).statusCode,
    200,
  );
  assert.equal(
    (await app.inject({ url: '/api/dashboard', headers: { cookie: second.cookie } })).statusCode,
    200,
  );
  assert.equal((await app.inject({ url: '/' })).statusCode, 200);
  assert.equal((await app.inject({ url: '/' })).statusCode, 200);
  assert.equal((await app.inject({ url: '/' })).statusCode, 429);
  await app.close();
  await store.close();
});

test('anonymous protected-route probes remain IP-rate-limited', async () => {
  const { app, store } = await fixture({ RATE_LIMIT_PER_MINUTE: '2' });
  assert.equal((await app.inject({ url: '/api/dashboard' })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/dashboard' })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/dashboard' })).statusCode, 429);
  await app.close();
  await store.close();
});

test('health probes cannot be throttled by public traffic', async () => {
  const { app, store } = await fixture({ RATE_LIMIT_PER_MINUTE: '1' });
  assert.equal((await app.inject({ url: '/' })).statusCode, 200);
  assert.equal((await app.inject({ url: '/' })).statusCode, 429);
  assert.equal((await app.inject({ url: '/health/live' })).statusCode, 200);
  assert.equal((await app.inject({ url: '/health/ready' })).statusCode, 200);
  await app.close();
  await store.close();
});

test('machine metrics use a dedicated bearer credential', async () => {
  const token = 'metrics-test-token'.padEnd(32, 'x');
  const { app, store } = await fixture({ METRICS_BEARER_TOKEN: token });
  assert.equal((await app.inject({ url: '/metrics' })).statusCode, 401);
  assert.equal(
    (await app.inject({ url: '/metrics', headers: { authorization: 'Bearer wrong' } })).statusCode,
    401,
  );
  const response = await app.inject({
    url: '/metrics',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /recruiting_os_http_requests_total/);
  assert.match(response.body, /recruiting_os_jobs\{status="queued"\}/);
  await app.close();
  await store.close();
});

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
  assert.match(page.body, /Private raw messages and screenshots are retained for up to 90 days/);
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
      consentToProcess: true,
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

test('connector sync requires a credential and revocation cancels pending schedules', async () => {
  const { app, store, credentialVault } = await fixture();
  const { cookie, csrf } = await login(app);
  await app.inject({
    method: 'POST',
    url: '/api/organizations',
    headers: { cookie, 'x-csrf-token': csrf },
    payload: { id: 'club', name: 'Club', school: 'UNC' },
  });

  const disconnected = await app.inject({
    method: 'POST',
    url: '/api/connectors/gmail/sync',
    headers: { cookie, 'x-csrf-token': csrf },
    payload: { organizationId: 'club' },
  });
  assert.equal(disconnected.statusCode, 409, disconnected.body);
  assert.equal(disconnected.json().error.code, 'CONNECTOR_NOT_CONNECTED');

  const user = store.db.prepare("select id from users where email='student@unc.edu'").get() as {
    id: string;
  };
  await credentialVault.put('unc', user.id, 'gmail', {
    accessToken: 'access',
    scopes: ['gmail.readonly'],
  });
  const queued = await app.inject({
    method: 'POST',
    url: '/api/connectors/gmail/sync',
    headers: { cookie, 'x-csrf-token': csrf },
    payload: { organizationId: 'club' },
  });
  assert.equal(queued.statusCode, 202, queued.body);

  const revoked = await app.inject({
    method: 'DELETE',
    url: '/api/connectors/gmail',
    headers: { cookie, 'x-csrf-token': csrf },
  });
  assert.equal(revoked.statusCode, 200, revoked.body);
  assert.equal(revoked.json().cancelledJobs, 1);
  assert.equal(await credentialVault.get('unc', user.id, 'gmail'), undefined);
  assert.equal(
    (
      store.db.prepare("select status from jobs where type='connector.sync'").get() as {
        status: string;
      }
    ).status,
    'cancelled',
  );
  await credentialVault.put('unc', user.id, 'gmail', {
    accessToken: 'replacement-access',
    scopes: ['gmail.readonly'],
  });
  const requeued = await app.inject({
    method: 'POST',
    url: '/api/connectors/gmail/sync',
    headers: { cookie, 'x-csrf-token': csrf },
    payload: { organizationId: 'club' },
  });
  assert.equal(requeued.statusCode, 202, requeued.body);
  assert.equal(requeued.json().jobId, queued.json().jobId);
  assert.equal(
    (
      store.db.prepare("select status from jobs where type='connector.sync'").get() as {
        status: string;
      }
    ).status,
    'queued',
  );
  await app.close();
  await store.close();
});

test('connecting a private provider requires versioned explicit consent', async () => {
  const { app, store } = await fixture();
  const { cookie, csrf } = await login(app);
  const denied = await app.inject({
    method: 'POST',
    url: '/api/connectors/gmail/connect',
    headers: { cookie, 'x-csrf-token': csrf },
    payload: {},
  });
  assert.equal(denied.statusCode, 422, denied.body);

  const accepted = await app.inject({
    method: 'POST',
    url: '/api/connectors/gmail/connect',
    headers: { cookie, 'x-csrf-token': csrf },
    payload: { consentToProcess: true },
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.match(accepted.json().authorizationUrl, /^https:\/\/accounts\.google\.com\//);
  await app.close();
  await store.close();
});

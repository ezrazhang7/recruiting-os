import assert from 'node:assert/strict';
import test from 'node:test';
import { postgresPoolOptions } from '../src/bootstrap/dependencies';
import { loadConfig } from '../src/config/env';

test('production refuses SQLite and development authentication', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /Production requires/);
});

test('production accepts explicit Postgres and OIDC configuration', () => {
  const config = loadConfig({
    NODE_ENV: 'production',
    DATABASE_DRIVER: 'postgres',
    DATABASE_URL: 'postgres://db/recruiting?sslmode=require',
    AUTH_MODE: 'oidc',
    OIDC_ISSUER: 'https://idp.example',
    OIDC_CLIENT_ID: 'client',
    OIDC_REDIRECT_URI: 'https://app.example/auth/callback',
    INITIAL_PLATFORM_ADMIN_EMAILS: 'admin@unc.edu',
    SESSION_SECRET: 'x'.repeat(32),
    CREDENTIAL_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    METRICS_BEARER_TOKEN: 'm'.repeat(32),
    ALLOWED_ORIGINS: 'https://app.example',
  });
  assert.equal(config.database.driver, 'postgres');
  assert.equal(config.auth.mode, 'oidc');
  assert.deepEqual(config.auth.initialPlatformAdminEmails, ['admin@unc.edu']);
});

test('database pool size is one explicit per-process budget', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_DRIVER: 'postgres',
    DATABASE_URL: 'postgres://db/recruiting?sslmode=require',
    DATABASE_POOL_SIZE: '6',
  });
  assert.deepEqual(
    {
      max: postgresPoolOptions(config, 'api').max,
      apiName: postgresPoolOptions(config, 'api').application_name,
      workerName: postgresPoolOptions(config, 'worker').application_name,
    },
    { max: 6, apiName: 'recruiting-os-api', workerName: 'recruiting-os-worker' },
  );
});

test('production rejects missing or insecure browser origins', () => {
  const base = {
    NODE_ENV: 'production',
    DATABASE_DRIVER: 'postgres',
    DATABASE_URL: 'postgres://db/recruiting?sslmode=require',
    AUTH_MODE: 'oidc',
    OIDC_ISSUER: 'https://idp.example',
    OIDC_CLIENT_ID: 'client',
    OIDC_REDIRECT_URI: 'https://app.example/auth/callback',
    INITIAL_PLATFORM_ADMIN_EMAILS: 'admin@unc.edu',
    SESSION_SECRET: 'x'.repeat(32),
    CREDENTIAL_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    METRICS_BEARER_TOKEN: 'm'.repeat(32),
  };
  assert.throws(() => loadConfig(base), /HTTPS ALLOWED_ORIGINS/);
  assert.throws(
    () => loadConfig({ ...base, ALLOWED_ORIGINS: 'http://app.example' }),
    /HTTPS ALLOWED_ORIGINS/,
  );
});

test('production requires a machine credential for metrics scraping', () => {
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_DRIVER: 'postgres',
        DATABASE_URL: 'postgres://db/recruiting?sslmode=require',
        AUTH_MODE: 'oidc',
        OIDC_ISSUER: 'https://idp.example',
        OIDC_CLIENT_ID: 'client',
        OIDC_REDIRECT_URI: 'https://app.example/auth/callback',
        INITIAL_PLATFORM_ADMIN_EMAILS: 'admin@unc.edu',
        SESSION_SECRET: 'x'.repeat(32),
        CREDENTIAL_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
        ALLOWED_ORIGINS: 'https://app.example',
      }),
    /METRICS_BEARER_TOKEN/,
  );
});

test('production permits no bootstrap entry after launch but rejects an off-domain entry', () => {
  const base = {
    NODE_ENV: 'production',
    DATABASE_DRIVER: 'postgres',
    DATABASE_URL: 'postgres://db/recruiting?sslmode=require',
    AUTH_MODE: 'oidc',
    OIDC_ISSUER: 'https://idp.example',
    OIDC_CLIENT_ID: 'client',
    OIDC_REDIRECT_URI: 'https://app.example/auth/callback',
    SESSION_SECRET: 'x'.repeat(32),
    CREDENTIAL_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    METRICS_BEARER_TOKEN: 'm'.repeat(32),
    ALLOWED_ORIGINS: 'https://app.example',
  };
  assert.deepEqual(loadConfig(base).auth.initialPlatformAdminEmails, []);
  assert.throws(
    () => loadConfig({ ...base, INITIAL_PLATFORM_ADMIN_EMAILS: 'admin@example.edu' }),
    /allowed OIDC email domain/,
  );
});

test('production refuses plaintext database and identity endpoints', () => {
  const base = {
    NODE_ENV: 'production',
    DATABASE_DRIVER: 'postgres',
    DATABASE_URL: 'postgres://db/recruiting?sslmode=require',
    AUTH_MODE: 'oidc',
    OIDC_ISSUER: 'https://idp.example',
    OIDC_CLIENT_ID: 'client',
    OIDC_REDIRECT_URI: 'https://app.example/auth/callback',
    INITIAL_PLATFORM_ADMIN_EMAILS: 'admin@unc.edu',
    SESSION_SECRET: 'x'.repeat(32),
    CREDENTIAL_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    METRICS_BEARER_TOKEN: 'm'.repeat(32),
    ALLOWED_ORIGINS: 'https://app.example',
  };
  assert.throws(
    () => loadConfig({ ...base, DATABASE_URL: 'postgres://db/recruiting' }),
    /must require TLS/,
  );
  assert.throws(
    () => loadConfig({ ...base, OIDC_ISSUER: 'http://idp.example' }),
    /credential-free HTTPS URL/,
  );
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config/env';

test('production refuses SQLite and development authentication', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /Production requires/);
});

test('production accepts explicit Postgres and OIDC configuration', () => {
  const config = loadConfig({
    NODE_ENV: 'production',
    DATABASE_DRIVER: 'postgres',
    DATABASE_URL: 'postgres://db/recruiting',
    AUTH_MODE: 'oidc',
    OIDC_ISSUER: 'https://idp.example',
    OIDC_CLIENT_ID: 'client',
    OIDC_REDIRECT_URI: 'https://app.example/auth/callback',
    SESSION_SECRET: 'x'.repeat(32),
    CREDENTIAL_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    METRICS_BEARER_TOKEN: 'm'.repeat(32),
    ALLOWED_ORIGINS: 'https://app.example',
  });
  assert.equal(config.database.driver, 'postgres');
  assert.equal(config.auth.mode, 'oidc');
});

test('production rejects missing or insecure browser origins', () => {
  const base = {
    NODE_ENV: 'production',
    DATABASE_DRIVER: 'postgres',
    DATABASE_URL: 'postgres://db/recruiting',
    AUTH_MODE: 'oidc',
    OIDC_ISSUER: 'https://idp.example',
    OIDC_CLIENT_ID: 'client',
    OIDC_REDIRECT_URI: 'https://app.example/auth/callback',
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
        DATABASE_URL: 'postgres://db/recruiting',
        AUTH_MODE: 'oidc',
        OIDC_ISSUER: 'https://idp.example',
        OIDC_CLIENT_ID: 'client',
        OIDC_REDIRECT_URI: 'https://app.example/auth/callback',
        SESSION_SECRET: 'x'.repeat(32),
        CREDENTIAL_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
        ALLOWED_ORIGINS: 'https://app.example',
      }),
    /METRICS_BEARER_TOKEN/,
  );
});

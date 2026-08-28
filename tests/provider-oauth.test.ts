import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderOAuthService } from '../src/infrastructure/auth/provider-oauth-service';

test('provider OAuth uses PKCE and validates provider-bound state', async () => {
  let tokenBody = '';
  const service = new ProviderOAuthService(
    {
      gmail: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'https://app.example/api/connectors/gmail/callback',
      },
    },
    async (_url, init) => {
      tokenBody = String(init?.body);
      return new Response(
        JSON.stringify({
          access_token: 'token',
          refresh_token: 'refresh',
          expires_in: 3600,
          scope: 'gmail.readonly',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  );
  const authorization = service.authorization('gmail', 'user', 'tenant');
  const url = new URL(authorization.url);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('code_challenge'));
  const credential = await service.callback('gmail', 'code', authorization.state);
  assert.match(tokenBody, /code_verifier=/);
  assert.equal(credential.accessToken, 'token');
  await assert.rejects(() => service.callback('linkedin', 'code', authorization.state), /mismatch/);
});

test('provider OAuth refresh preserves a rotated refresh token and scopes', async () => {
  let tokenBody = '';
  const service = new ProviderOAuthService(
    {
      gmail: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'https://app.example/api/connectors/gmail/callback',
      },
    },
    async (_url, init) => {
      tokenBody = String(init?.body);
      return new Response(
        JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  );

  const refreshed = await service.refresh('gmail', {
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: new Date(0).toISOString(),
    scopes: ['gmail.readonly'],
  });

  assert.match(tokenBody, /grant_type=refresh_token/);
  assert.match(tokenBody, /refresh_token=old-refresh/);
  assert.equal(refreshed.accessToken, 'new-access');
  assert.equal(refreshed.refreshToken, 'new-refresh');
  assert.deepEqual(refreshed.scopes, ['gmail.readonly']);
  assert.ok(Date.parse(refreshed.expiresAt!) > Date.now());
});

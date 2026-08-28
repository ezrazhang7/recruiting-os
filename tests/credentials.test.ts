import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  CredentialRepository,
  StoredCredential,
} from '../src/application/ports/credential-repository';
import { EncryptedCredentialVault } from '../src/infrastructure/credentials/encrypted-credential-vault';
import { RefreshingCredentialService } from '../src/application/connectors/refreshing-credential-service';
import { ProviderOAuthService } from '../src/infrastructure/auth/provider-oauth-service';
import type { AuditEvent, AuditLog } from '../src/application/ports/audit-log';

class MemoryCredentials implements CredentialRepository {
  value?: StoredCredential;
  async save(value: StoredCredential) {
    this.value = value;
  }
  async find() {
    return this.value;
  }
  async revoke() {
    if (this.value) this.value = { ...this.value, revokedAt: new Date().toISOString() };
  }
  async close() {}
}
test('provider credentials are authenticated-encrypted and revocable', async () => {
  const repository = new MemoryCredentials();
  const vault = new EncryptedCredentialVault(
    repository,
    Buffer.alloc(32, 7).toString('base64'),
    'v1',
  );
  await vault.put('tenant', 'user', 'gmail', {
    accessToken: 'secret-access',
    refreshToken: 'secret-refresh',
    scopes: ['gmail.readonly'],
  });
  assert.ok(repository.value);
  assert.equal(repository.value.encryptedPayload.includes(Buffer.from('secret-access')), false);
  assert.equal((await vault.get('tenant', 'user', 'gmail'))?.refreshToken, 'secret-refresh');
  await vault.revoke('tenant', 'user', 'gmail');
  assert.equal(await vault.get('tenant', 'user', 'gmail'), undefined);
});

test('credential ciphertext is bound to tenant, user, and provider', async () => {
  const repository = new MemoryCredentials();
  const vault = new EncryptedCredentialVault(
    repository,
    Buffer.alloc(32, 7).toString('base64'),
    'v1',
  );
  await vault.put('tenant-a', 'user', 'gmail', { accessToken: 'secret', scopes: [] });
  await assert.rejects(() => vault.get('tenant-b', 'user', 'gmail'));
});

test('expired connector credentials are refreshed, persisted, and audited', async () => {
  const repository = new MemoryCredentials();
  const vault = new EncryptedCredentialVault(
    repository,
    Buffer.alloc(32, 7).toString('base64'),
    'v1',
  );
  await vault.put('tenant', 'user', 'gmail', {
    accessToken: 'expired',
    refreshToken: 'refresh',
    expiresAt: new Date(0).toISOString(),
    scopes: ['gmail.readonly'],
  });
  const audit = new MemoryAuditLog();
  const oauth = new ProviderOAuthService(
    {
      gmail: {
        clientId: 'client',
        clientSecret: 'secret',
        redirectUri: 'https://app.example/api/connectors/gmail/callback',
      },
    },
    async () =>
      new Response(JSON.stringify({ access_token: 'fresh', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  const service = new RefreshingCredentialService(vault, oauth, audit);

  const credential = await service.getValid('tenant', 'user', 'gmail', 'job-1');

  assert.equal(credential?.accessToken, 'fresh');
  assert.equal((await vault.get('tenant', 'user', 'gmail'))?.accessToken, 'fresh');
  assert.equal(audit.events[0]?.action, 'connector.credential.refresh');
  assert.equal(audit.events[0]?.requestId, 'job-1');
});

class MemoryAuditLog implements AuditLog {
  readonly events: AuditEvent[] = [];
  async write(event: AuditEvent) {
    this.events.push(event);
  }
  async close() {}
}

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { CredentialRepository } from '../../application/ports/credential-repository';
import type { CredentialVault, ProviderCredential } from '../../application/ports/credential-vault';
import { stableId } from '../../lib/util';

export class EncryptedCredentialVault implements CredentialVault {
  private readonly key: Buffer;
  constructor(
    private readonly repository: CredentialRepository,
    keyBase64: string,
    private readonly keyVersion: string,
  ) {
    this.key = Buffer.from(keyBase64, 'base64');
    if (this.key.length !== 32)
      throw new Error('CREDENTIAL_MASTER_KEY must decode to exactly 32 bytes');
  }
  async put(
    tenantId: string,
    userId: string,
    provider: string,
    credential: ProviderCredential,
  ): Promise<void> {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(`${tenantId}:${userId}:${provider}`));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(credential), 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    await this.repository.save({
      id: stableId('cred', `${tenantId}:${userId}:${provider}`),
      tenantId,
      userId,
      provider,
      encryptedPayload: Buffer.concat([nonce, tag, ciphertext]),
      keyVersion: this.keyVersion,
      scopes: credential.scopes,
      expiresAt: credential.expiresAt,
    });
  }
  async get(
    tenantId: string,
    userId: string,
    provider: string,
  ): Promise<ProviderCredential | undefined> {
    const stored = await this.repository.find(tenantId, userId, provider);
    if (!stored || stored.revokedAt) return undefined;
    if (stored.keyVersion !== this.keyVersion) throw new Error('Credential requires key rotation');
    const nonce = stored.encryptedPayload.subarray(0, 12);
    const tag = stored.encryptedPayload.subarray(12, 28);
    const ciphertext = stored.encryptedPayload.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
    decipher.setAAD(Buffer.from(`${tenantId}:${userId}:${provider}`));
    decipher.setAuthTag(tag);
    return JSON.parse(
      Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'),
    ) as ProviderCredential;
  }
  async revoke(tenantId: string, userId: string, provider: string): Promise<void> {
    await this.repository.revoke(tenantId, userId, provider);
  }
}

import type { AuditLog } from '../ports/audit-log';
import type { CredentialVault, ProviderCredential } from '../ports/credential-vault';
import {
  ProviderOAuthService,
  type OAuthProvider,
} from '../../infrastructure/auth/provider-oauth-service';

export class RefreshingCredentialService {
  constructor(
    private readonly vault: CredentialVault,
    private readonly oauth: ProviderOAuthService,
    private readonly auditLog?: AuditLog,
    private readonly refreshSkewMs = 60_000,
  ) {}

  async getValid(
    tenantId: string,
    userId: string,
    provider: OAuthProvider,
    requestId?: string,
  ): Promise<ProviderCredential | undefined> {
    const credential = await this.vault.get(tenantId, userId, provider);
    if (!credential || !this.needsRefresh(credential)) return credential;
    const refreshed = await this.oauth.refresh(provider, credential);
    await this.vault.put(tenantId, userId, provider, refreshed);
    await this.auditLog?.write({
      tenantId,
      actorId: userId,
      action: 'connector.credential.refresh',
      resourceType: 'connector',
      resourceId: provider,
      requestId,
    });
    return refreshed;
  }

  private needsRefresh(credential: ProviderCredential): boolean {
    if (!credential.expiresAt) return false;
    const expiresAt = Date.parse(credential.expiresAt);
    if (!Number.isFinite(expiresAt)) throw new Error('Connector credential expiry is invalid');
    return expiresAt <= Date.now() + this.refreshSkewMs;
  }
}

export interface ProviderCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scopes: string[];
  metadata?: Record<string, unknown>;
}
export interface CredentialVault {
  put(
    tenantId: string,
    userId: string,
    provider: string,
    credential: ProviderCredential,
  ): Promise<void>;
  get(tenantId: string, userId: string, provider: string): Promise<ProviderCredential | undefined>;
  revoke(tenantId: string, userId: string, provider: string): Promise<void>;
}

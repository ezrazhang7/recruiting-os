import type { AuthPrincipal, Role } from '../../domain/models';

export interface SessionAuthentication {
  principal: AuthPrincipal;
  csrfHash: string;
  expiresAt: string;
}

export interface OidcIdentity {
  issuer: string;
  subject: string;
  email?: string;
  displayName?: string;
}

export interface AuthRepository {
  upsertIdentity(identity: OidcIdentity, tenantId: string, defaultRoles?: Role[]): Promise<string>;
  createSession(input: {
    id: string;
    tenantId: string;
    userId: string;
    tokenHash: string;
    csrfHash: string;
    expiresAt: string;
  }): Promise<void>;
  authenticateSession(tokenHash: string): Promise<SessionAuthentication | undefined>;
  revokeSession(sessionId: string, tenantId: string): Promise<void>;
  close(): Promise<void>;
}

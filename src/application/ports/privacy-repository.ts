import type { Role, SourceType, SourceVersionStatus } from '../../domain/models';

export interface AccountDataExport {
  generatedAt: string;
  identity: {
    id: string;
    issuer: string;
    subject: string;
    email?: string;
    displayName?: string;
    createdAt: string;
  };
  membership: {
    tenantId: string;
    roles: Role[];
    organizationIds: string[];
    createdAt: string;
  };
  connectors: Array<{
    provider: string;
    scopes: string[];
    expiresAt?: string;
    revokedAt?: string;
    createdAt: string;
  }>;
  contributions: Array<{
    sourceVersionId: string;
    organizationId: string;
    sourceType: SourceType;
    title?: string;
    url?: string;
    publishedAt?: string;
    fetchedAt: string;
    status: SourceVersionStatus;
    shared: boolean;
  }>;
  activity: Array<{
    action: string;
    resourceType: string;
    resourceId?: string;
    createdAt: string;
  }>;
}

export interface AccountErasureResult {
  membershipDeleted: boolean;
  identityDeleted: boolean;
  credentialsDeleted: number;
  sessionsDeleted: number;
  jobsDeleted: number;
  connectorStatesDeleted: number;
  contributionsRemoved: number;
  privateSourceVersionsDeleted: number;
  claimsDeleted: number;
  affectedOrganizationIds: string[];
  reconciliationJobIds: string[];
}

export interface PrivacyRepository {
  exportAccount(tenantId: string, userId: string): Promise<AccountDataExport | undefined>;
  eraseAccount(
    tenantId: string,
    userId: string,
    operationId: string,
  ): Promise<AccountErasureResult>;
  close(): Promise<void>;
}

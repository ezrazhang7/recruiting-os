import type {
  Claim,
  Organization,
  Opportunity,
  OpportunityOverride,
  ProcessingFailure,
  SourceItem,
  StageSourceResult,
} from '../../domain/models';

export interface RecruitingRepository {
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  upsertOrganization(organization: Organization, tenantId?: string): Promise<void>;
  getOrganization(id: string, tenantId?: string): Promise<Organization | undefined>;
  listOrganizations(tenantId?: string): Promise<Organization[]>;
  stageSource(source: SourceItem, tenantId?: string): Promise<StageSourceResult>;
  markSourceProcessing(versionId: string, tenantId?: string): Promise<number>;
  markSourceSucceeded(versionId: string, tenantId?: string): Promise<void>;
  markSourceFailed(versionId: string, failure: ProcessingFailure, tenantId?: string): Promise<void>;
  getSource(id: string, tenantId?: string): Promise<SourceItem | undefined>;
  putClaims(claims: Claim[], tenantId?: string): Promise<void>;
  listClaims(organizationId: string, tenantId?: string): Promise<Claim[]>;
  replaceOpportunities(
    organizationId: string,
    opportunities: Opportunity[],
    tenantId?: string,
  ): Promise<void>;
  listOpportunities(organizationId?: string, tenantId?: string): Promise<Opportunity[]>;
  putOpportunityOverride(override: OpportunityOverride, tenantId?: string): Promise<void>;
  listOpportunityOverrides(
    organizationId: string,
    tenantId?: string,
  ): Promise<OpportunityOverride[]>;
  getConnectorState(
    connector: string,
    scope: string,
    tenantId?: string,
  ): Promise<{ cursor?: string; metadata: Record<string, unknown> }>;
  setConnectorState(
    connector: string,
    scope: string,
    cursor?: string,
    metadata?: Record<string, unknown>,
    tenantId?: string,
    ownerUserId?: string,
  ): Promise<void>;
  close(): Promise<void>;
}

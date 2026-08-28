export const DEFAULT_TENANT_ID = 'tenant_default';

export type Role = 'student' | 'organization_editor' | 'platform_admin';

export type SourceType =
  | 'gmail'
  | 'groupme'
  | 'instagram'
  | 'linkedin'
  | 'website'
  | 'bio_link'
  | 'application'
  | 'screenshot'
  | 'heel_life';

export type ClaimField =
  | 'application_open'
  | 'application_deadline'
  | 'application_url'
  | 'event'
  | 'requirement'
  | 'status'
  | 'social_handle'
  | 'recruiting_note';

export type SourceVersionStatus =
  'received' | 'queued' | 'processing' | 'succeeded' | 'retryable_failed' | 'terminal_failed';
export type TemporalPrecision = 'date' | 'date_time' | 'relative_inferred';

export interface Organization {
  id: string;
  tenantId?: string;
  name: string;
  school: string;
  heelLifeUrl?: string;
  websiteUrl?: string;
  instagramHandle?: string;
  linkedinUrl?: string;
}

export interface MediaRef {
  type: 'image' | 'video' | 'document';
  url?: string;
  base64?: string;
  mimeType?: string;
  alt?: string;
}

export interface SourceItem {
  id: string;
  tenantId?: string;
  contributorUserId?: string;
  organizationId: string;
  sourceType: SourceType;
  externalId?: string;
  url?: string;
  title?: string;
  rawText: string;
  media: MediaRef[];
  publishedAt?: string;
  fetchedAt: string;
  metadata?: Record<string, unknown>;
}

export interface EventValue {
  title: string;
  startsAt?: string;
  endsAt?: string;
  location?: string;
  mandatory?: boolean;
  url?: string;
}

export interface Claim {
  id: string;
  tenantId?: string;
  organizationId: string;
  sourceItemId: string;
  field: ClaimField;
  value: unknown;
  confidence: number;
  publishedAt?: string;
  extractedAt: string;
  evidence?: string;
  supersedes?: string[];
  temporalPrecision?: TemporalPrecision;
}

export interface Opportunity {
  id: string;
  tenantId?: string;
  organizationId: string;
  kind: 'application' | 'event' | 'task';
  title: string;
  deadlineAt?: string;
  startsAt?: string;
  url?: string;
  role?: string;
  confidence: number;
  stale: boolean;
  sourceClaimIds: string[];
  explanation: string;
  resolvedAt: string;
  resolverVersion?: string;
  deadlinePrecision?: TemporalPrecision;
  startsAtPrecision?: TemporalPrecision;
}

export interface OpportunityOverride {
  id: string;
  tenantId: string;
  opportunityId: string;
  organizationId: string;
  actorId?: string;
  patch: Partial<Pick<Opportunity, 'title' | 'deadlineAt' | 'startsAt' | 'url' | 'stale'>>;
  reason: string;
  createdAt: string;
}

export interface ExtractionResult {
  claims: Array<{
    field: ClaimField;
    value: unknown;
    confidence: number;
    evidence?: string;
    temporalPrecision?: TemporalPrecision;
  }>;
  discoveredUrls: string[];
}

export interface StageSourceResult {
  sourceId: string;
  versionId: string;
  status: SourceVersionStatus;
  shouldProcess: boolean;
  unchanged: boolean;
  attemptCount: number;
}

export interface ProcessingFailure {
  retryable: boolean;
  message: string;
  nextAttemptAt?: string;
}

export interface AuthPrincipal {
  userId: string;
  tenantId: string;
  roles: Role[];
  organizationIds: string[];
  sessionId: string;
}

export type JobStatus =
  'queued' | 'running' | 'succeeded' | 'retryable_failed' | 'dead_letter' | 'cancelled';
export interface Job<T = Record<string, unknown>> {
  id: string;
  tenantId: string;
  type: string;
  idempotencyKey: string;
  payload: T;
  status: JobStatus;
  attemptCount: number;
  maxAttempts: number;
  availableAt: string;
  leasedBy?: string;
  leasedUntil?: string;
}

export type HttpClient = (input: string | URL, init?: RequestInit) => Promise<Response>;

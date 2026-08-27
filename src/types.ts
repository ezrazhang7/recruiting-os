export type SourceType =
  | 'gmail' | 'groupme' | 'instagram' | 'linkedin'
  | 'website' | 'bio_link' | 'application' | 'screenshot' | 'heel_life';

export type ClaimField =
  | 'application_open' | 'application_deadline' | 'application_url'
  | 'event' | 'requirement' | 'status' | 'social_handle' | 'recruiting_note';

export interface Organization {
  id: string;
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
  organizationId: string;
  sourceItemId: string;
  field: ClaimField;
  value: unknown;
  confidence: number;
  publishedAt?: string;
  extractedAt: string;
  evidence?: string;
  supersedes?: string[];
}

export interface Opportunity {
  id: string;
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
}

export interface ExtractionResult {
  claims: Array<{
    field: ClaimField;
    value: unknown;
    confidence: number;
    evidence?: string;
  }>;
  discoveredUrls: string[];
}

export type HttpClient = (input: string | URL, init?: RequestInit) => Promise<Response>;

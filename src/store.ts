import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RecruitingRepository } from './application/ports/recruiting-repository';
import {
  DEFAULT_TENANT_ID,
  type Claim,
  type Organization,
  type Opportunity,
  type OpportunityOverride,
  type ProcessingFailure,
  type SourceItem,
  type SourceType,
  type SourceVersionStatus,
  type StageSourceResult,
} from './domain/models';
import { nowIso, parseJsonSafe, stableId } from './lib/util';

const schema = `
create table if not exists tenants (
  id text primary key, name text not null, created_at text not null
);
create table if not exists organizations (
  tenant_id text not null references tenants(id) on delete cascade,
  id text not null, name text not null, school text not null,
  heel_life_url text, website_url text, instagram_handle text, linkedin_url text,
  created_at text not null, updated_at text not null,
  primary key (tenant_id, id)
);
create table if not exists sources (
  id text primary key, tenant_id text not null, organization_id text not null,
  source_type text not null, identity_key text not null, external_id text, url text, title text,
  created_at text not null, last_seen_at text not null,
  foreign key (tenant_id, organization_id) references organizations(tenant_id, id) on delete cascade,
  unique (tenant_id, organization_id, source_type, identity_key)
);
create table if not exists source_versions (
  id text primary key, source_id text not null references sources(id) on delete cascade,
  tenant_id text not null, organization_id text not null, content_hash text not null,
  raw_text text not null, media text not null default '[]', published_at text,
  fetched_at text not null, metadata text not null default '{}',
  status text not null check(status in ('received','queued','processing','succeeded','retryable_failed','terminal_failed')),
  attempt_count integer not null default 0 check(attempt_count >= 0),
  next_attempt_at text, last_error text, started_at text, completed_at text, created_at text not null,
  unique(source_id, content_hash)
);
create index if not exists source_versions_ready on source_versions(status, next_attempt_at, created_at);
create index if not exists source_versions_org on source_versions(tenant_id, organization_id, fetched_at desc);
create table if not exists claims (
  id text primary key, tenant_id text not null, organization_id text not null,
  source_version_id text not null references source_versions(id) on delete cascade,
  field text not null, value text not null,
  confidence real not null check(confidence >= 0 and confidence <= 1),
  published_at text, extracted_at text not null, supersedes text not null default '[]', evidence text,
  temporal_precision text check(temporal_precision in ('date','date_time','relative_inferred')),
  unique(source_version_id, field, value)
);
create index if not exists claims_org_field on claims(tenant_id, organization_id, field, published_at desc);
create table if not exists opportunities (
  id text not null, tenant_id text not null, organization_id text not null,
  kind text not null check(kind in ('application','event','task')), title text not null,
  deadline_at text, starts_at text, url text, role text,
  confidence real not null check(confidence >= 0 and confidence <= 1),
  stale integer not null default 0 check(stale in (0,1)), source_claim_ids text not null,
  explanation text not null, resolver_version text not null, resolved_at text not null,
  deadline_precision text check(deadline_precision in ('date','date_time','relative_inferred')),
  starts_at_precision text check(starts_at_precision in ('date','date_time','relative_inferred')),
  primary key (tenant_id, id),
  foreign key (tenant_id, organization_id) references organizations(tenant_id, id) on delete cascade
);
create index if not exists opportunities_org on opportunities(tenant_id, organization_id, deadline_at, starts_at);
create table if not exists opportunity_overrides (
  id text primary key, tenant_id text not null, opportunity_id text not null,
  organization_id text not null, actor_id text not null, patch text not null,
  reason text not null, created_at text not null, revoked_at text,
  foreign key (tenant_id, organization_id) references organizations(tenant_id, id) on delete cascade
);
create index if not exists opportunity_overrides_active
  on opportunity_overrides(tenant_id, opportunity_id, created_at desc);
create table if not exists connector_state (
  tenant_id text not null, connector text not null, scope text not null, cursor text,
  metadata text not null default '{}', updated_at text not null,
  primary key(tenant_id, connector, scope),
  foreign key (tenant_id) references tenants(id) on delete cascade
);
create table if not exists audit_events (
  id text primary key, tenant_id text not null, actor_id text, action text not null,
  resource_type text not null, resource_id text, request_id text,
  metadata text not null default '{}', created_at text not null
);
create table if not exists jobs (
  id text primary key, tenant_id text not null references tenants(id) on delete cascade,
  type text not null, idempotency_key text not null, payload text not null,
  status text not null check(status in ('queued','running','succeeded','retryable_failed','dead_letter','cancelled')),
  priority integer not null default 100, attempt_count integer not null default 0,
  max_attempts integer not null default 5, available_at text not null,
  leased_until text, leased_by text, last_error text, created_at text not null, updated_at text not null,
  unique(tenant_id,type,idempotency_key)
);
create index if not exists jobs_ready on jobs(status,available_at,priority,created_at);
create table if not exists tenant_queue_state (
  tenant_id text primary key references tenants(id) on delete cascade,last_leased_at text
);
create table if not exists users (
  id text primary key, issuer text not null, subject text not null, email text, display_name text,
  created_at text not null, updated_at text not null, unique(issuer,subject)
);
create table if not exists memberships (
  tenant_id text not null references tenants(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  roles text not null, organization_ids text not null default '[]', created_at text not null,
  updated_at text not null, primary key(tenant_id,user_id)
);
create table if not exists sessions (
  id text primary key, tenant_id text not null references tenants(id) on delete cascade,
  user_id text not null references users(id) on delete cascade, token_hash text not null unique,
  csrf_hash text not null, expires_at text not null, revoked_at text, created_at text not null,
  last_seen_at text not null
);
create index if not exists sessions_expiry on sessions(expires_at,revoked_at);
create table if not exists credentials (
  id text primary key, tenant_id text not null references tenants(id) on delete cascade,
  user_id text not null references users(id) on delete cascade, provider text not null,
  encrypted_payload blob not null, key_version text not null, scopes text not null default '[]',
  expires_at text, revoked_at text, created_at text not null, updated_at text not null,
  unique(tenant_id,user_id,provider)
);
`;

function contentHash(source: SourceItem): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        rawText: source.rawText,
        media: source.media,
        publishedAt: source.publishedAt ?? null,
        metadata: source.metadata ?? {},
      }),
    )
    .digest('hex');
}

function sourceIdentity(source: SourceItem): string {
  return source.externalId ?? source.url ?? source.id;
}

export class Store implements RecruitingRepository {
  readonly db: DatabaseSync;
  private transactionDepth = 0;

  constructor(
    path = ':memory:',
    private readonly defaultTenantId = DEFAULT_TENANT_ID,
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('pragma foreign_keys=on; pragma journal_mode=wal; pragma busy_timeout=5000;');
    this.db.exec(schema);
    this.ensureTenant(defaultTenantId, 'Default tenant');
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    if (this.transactionDepth > 0) return operation();
    this.db.exec('begin immediate');
    this.transactionDepth += 1;
    try {
      const result = await operation();
      this.db.exec('commit');
      return result;
    } catch (error) {
      this.db.exec('rollback');
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  ensureTenant(id: string, name: string): void {
    this.db
      .prepare('insert or ignore into tenants(id,name,created_at) values(?,?,?)')
      .run(id, name, nowIso());
  }

  async upsertOrganization(
    organization: Organization,
    tenantId = organization.tenantId ?? this.defaultTenantId,
  ): Promise<void> {
    this.ensureTenant(tenantId, tenantId);
    const now = nowIso();
    this.db
      .prepare(
        `insert into organizations(
      tenant_id,id,name,school,heel_life_url,website_url,instagram_handle,linkedin_url,created_at,updated_at
    ) values(?,?,?,?,?,?,?,?,?,?)
    on conflict(tenant_id,id) do update set
      name=excluded.name, school=excluded.school,
      heel_life_url=coalesce(excluded.heel_life_url,organizations.heel_life_url),
      website_url=coalesce(excluded.website_url,organizations.website_url),
      instagram_handle=coalesce(excluded.instagram_handle,organizations.instagram_handle),
      linkedin_url=coalesce(excluded.linkedin_url,organizations.linkedin_url),
      updated_at=excluded.updated_at`,
      )
      .run(
        tenantId,
        organization.id,
        organization.name,
        organization.school,
        organization.heelLifeUrl ?? null,
        organization.websiteUrl ?? null,
        organization.instagramHandle ?? null,
        organization.linkedinUrl ?? null,
        now,
        now,
      );
  }

  async getOrganization(
    id: string,
    tenantId = this.defaultTenantId,
  ): Promise<Organization | undefined> {
    const row = this.db
      .prepare('select * from organizations where tenant_id=? and id=?')
      .get(tenantId, id) as Record<string, unknown> | undefined;
    return row ? this.mapOrganization(row) : undefined;
  }

  async listOrganizations(tenantId = this.defaultTenantId): Promise<Organization[]> {
    return (
      this.db
        .prepare('select * from organizations where tenant_id=? order by name')
        .all(tenantId) as Record<string, unknown>[]
    ).map((row) => this.mapOrganization(row));
  }

  async stageSource(
    source: SourceItem,
    tenantId = source.tenantId ?? this.defaultTenantId,
  ): Promise<StageSourceResult> {
    const identity = sourceIdentity(source);
    const sourceId = stableId(
      'src',
      `${tenantId}:${source.organizationId}:${source.sourceType}:${identity}`,
    );
    const hash = contentHash(source);
    const versionId = stableId('srcv', `${sourceId}:${hash}`);
    const now = nowIso();

    return this.transaction(async () => {
      this.db
        .prepare(
          `insert into sources(
        id,tenant_id,organization_id,source_type,identity_key,external_id,url,title,created_at,last_seen_at
      ) values(?,?,?,?,?,?,?,?,?,?)
      on conflict(tenant_id,organization_id,source_type,identity_key) do update set
        external_id=excluded.external_id,url=excluded.url,title=excluded.title,last_seen_at=excluded.last_seen_at`,
        )
        .run(
          sourceId,
          tenantId,
          source.organizationId,
          source.sourceType,
          identity,
          source.externalId ?? null,
          source.url ?? null,
          source.title ?? null,
          now,
          now,
        );

      this.db
        .prepare(
          `insert or ignore into source_versions(
        id,source_id,tenant_id,organization_id,content_hash,raw_text,media,published_at,
        fetched_at,metadata,status,attempt_count,created_at
      ) values(?,?,?,?,?,?,?,?,?,?,?,0,?)`,
        )
        .run(
          versionId,
          sourceId,
          tenantId,
          source.organizationId,
          hash,
          source.rawText,
          JSON.stringify(source.media),
          source.publishedAt ?? null,
          source.fetchedAt,
          JSON.stringify(source.metadata ?? {}),
          'received',
          now,
        );

      const row = this.db
        .prepare('select status,attempt_count from source_versions where tenant_id=? and id=?')
        .get(tenantId, versionId) as { status: SourceVersionStatus; attempt_count: number };
      const shouldProcess = row.status === 'received' || row.status === 'retryable_failed';
      if (shouldProcess) {
        this.db
          .prepare(
            `update source_versions set status='queued',next_attempt_at=null where tenant_id=? and id=?`,
          )
          .run(tenantId, versionId);
      }
      return {
        sourceId,
        versionId,
        status: shouldProcess ? 'queued' : row.status,
        shouldProcess,
        unchanged: row.status !== 'received',
        attemptCount: row.attempt_count,
      };
    });
  }

  /** Compatibility shim; application code should use stageSource. */
  async putSource(source: SourceItem): Promise<boolean> {
    return (await this.stageSource(source)).shouldProcess;
  }

  async markSourceProcessing(versionId: string, tenantId = this.defaultTenantId): Promise<number> {
    const result = this.db
      .prepare(
        `update source_versions
      set status='processing',attempt_count=attempt_count+1,started_at=?,last_error=null
      where tenant_id=? and id=? and status in ('queued','retryable_failed','received')`,
      )
      .run(nowIso(), tenantId, versionId);
    if (Number(result.changes) !== 1) throw new Error('Source version is not ready for processing');
    const row = this.db
      .prepare('select attempt_count from source_versions where tenant_id=? and id=?')
      .get(tenantId, versionId) as { attempt_count: number };
    return row.attempt_count;
  }

  async markSourceSucceeded(versionId: string, tenantId = this.defaultTenantId): Promise<void> {
    this.db
      .prepare(
        `update source_versions set status='succeeded',completed_at=?,next_attempt_at=null,last_error=null
      where tenant_id=? and id=?`,
      )
      .run(nowIso(), tenantId, versionId);
  }

  async markSourceFailed(
    versionId: string,
    failure: ProcessingFailure,
    tenantId = this.defaultTenantId,
  ): Promise<void> {
    const status: SourceVersionStatus = failure.retryable ? 'retryable_failed' : 'terminal_failed';
    this.db
      .prepare(
        `update source_versions set status=?,last_error=?,next_attempt_at=?,completed_at=?
      where tenant_id=? and id=?`,
      )
      .run(
        status,
        failure.message.slice(0, 500),
        failure.nextAttemptAt ?? null,
        nowIso(),
        tenantId,
        versionId,
      );
  }

  async getSource(id: string, tenantId = this.defaultTenantId): Promise<SourceItem | undefined> {
    const row = this.db
      .prepare(
        `select v.id as version_id,v.organization_id,s.source_type,s.external_id,
      s.url,s.title,v.raw_text,v.media,v.published_at,v.fetched_at,v.metadata,v.tenant_id
      from source_versions v join sources s on s.id=v.source_id
      where v.tenant_id=? and (v.id=? or s.id=?) order by v.fetched_at desc limit 1`,
      )
      .get(tenantId, id, id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.version_id),
      tenantId: String(row.tenant_id),
      organizationId: String(row.organization_id),
      sourceType: String(row.source_type) as SourceType,
      externalId: row.external_id ? String(row.external_id) : undefined,
      url: row.url ? String(row.url) : undefined,
      title: row.title ? String(row.title) : undefined,
      rawText: String(row.raw_text),
      media: parseJsonSafe(String(row.media), []),
      publishedAt: row.published_at ? String(row.published_at) : undefined,
      fetchedAt: String(row.fetched_at),
      metadata: parseJsonSafe(String(row.metadata), {}),
    };
  }

  async putClaims(claims: Claim[], tenantId = this.defaultTenantId): Promise<void> {
    const statement = this.db.prepare(`insert into claims(
      id,tenant_id,organization_id,source_version_id,field,value,confidence,published_at,
      extracted_at,supersedes,evidence,temporal_precision
    ) values(?,?,?,?,?,?,?,?,?,?,?,?)
    on conflict(source_version_id,field,value) do update set
      confidence=excluded.confidence,evidence=excluded.evidence,extracted_at=excluded.extracted_at`);
    for (const claim of claims)
      statement.run(
        claim.id,
        claim.tenantId ?? tenantId,
        claim.organizationId,
        claim.sourceItemId,
        claim.field,
        JSON.stringify(claim.value),
        claim.confidence,
        claim.publishedAt ?? null,
        claim.extractedAt,
        JSON.stringify(claim.supersedes ?? []),
        claim.evidence ?? null,
        claim.temporalPrecision ?? null,
      );
  }

  async listClaims(organizationId: string, tenantId = this.defaultTenantId): Promise<Claim[]> {
    const rows = this.db
      .prepare(
        `select * from claims where tenant_id=? and organization_id=?
      order by coalesce(published_at,extracted_at)`,
      )
      .all(tenantId, organizationId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      organizationId: String(row.organization_id),
      sourceItemId: String(row.source_version_id),
      field: String(row.field) as Claim['field'],
      value: parseJsonSafe(String(row.value), null),
      confidence: Number(row.confidence),
      publishedAt: row.published_at ? String(row.published_at) : undefined,
      extractedAt: String(row.extracted_at),
      supersedes: parseJsonSafe(String(row.supersedes), []),
      evidence: row.evidence ? String(row.evidence) : undefined,
      temporalPrecision: row.temporal_precision
        ? (String(row.temporal_precision) as Claim['temporalPrecision'])
        : undefined,
    }));
  }

  async replaceOpportunities(
    organizationId: string,
    opportunities: Opportunity[],
    tenantId = this.defaultTenantId,
  ): Promise<void> {
    this.db
      .prepare('delete from opportunities where tenant_id=? and organization_id=?')
      .run(tenantId, organizationId);
    const statement = this.db.prepare(`insert into opportunities(
      id,tenant_id,organization_id,kind,title,deadline_at,starts_at,url,role,confidence,stale,
      source_claim_ids,explanation,resolver_version,resolved_at,deadline_precision,starts_at_precision
    ) values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const opportunity of opportunities)
      statement.run(
        opportunity.id,
        opportunity.tenantId ?? tenantId,
        opportunity.organizationId,
        opportunity.kind,
        opportunity.title,
        opportunity.deadlineAt ?? null,
        opportunity.startsAt ?? null,
        opportunity.url ?? null,
        opportunity.role ?? null,
        opportunity.confidence,
        opportunity.stale ? 1 : 0,
        JSON.stringify(opportunity.sourceClaimIds),
        opportunity.explanation,
        opportunity.resolverVersion ?? 'resolver-v1',
        opportunity.resolvedAt,
        opportunity.deadlinePrecision ?? null,
        opportunity.startsAtPrecision ?? null,
      );
  }

  async listOpportunities(
    organizationId?: string,
    tenantId = this.defaultTenantId,
  ): Promise<Opportunity[]> {
    const rows = (
      organizationId
        ? this.db
            .prepare(
              `select * from opportunities where tenant_id=? and organization_id=?
          order by coalesce(deadline_at,starts_at)`,
            )
            .all(tenantId, organizationId)
        : this.db
            .prepare(
              `select * from opportunities where tenant_id=?
          order by coalesce(deadline_at,starts_at)`,
            )
            .all(tenantId)
    ) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      organizationId: String(row.organization_id),
      kind: String(row.kind) as Opportunity['kind'],
      title: String(row.title),
      deadlineAt: row.deadline_at ? String(row.deadline_at) : undefined,
      startsAt: row.starts_at ? String(row.starts_at) : undefined,
      url: row.url ? String(row.url) : undefined,
      role: row.role ? String(row.role) : undefined,
      confidence: Number(row.confidence),
      stale: Boolean(row.stale),
      sourceClaimIds: parseJsonSafe(String(row.source_claim_ids), []),
      explanation: String(row.explanation),
      resolverVersion: String(row.resolver_version),
      resolvedAt: String(row.resolved_at),
      deadlinePrecision: row.deadline_precision
        ? (String(row.deadline_precision) as Opportunity['deadlinePrecision'])
        : undefined,
      startsAtPrecision: row.starts_at_precision
        ? (String(row.starts_at_precision) as Opportunity['startsAtPrecision'])
        : undefined,
    }));
  }

  async putOpportunityOverride(
    override: OpportunityOverride,
    tenantId = override.tenantId ?? this.defaultTenantId,
  ): Promise<void> {
    this.db
      .prepare(
        `insert into opportunity_overrides(
          id,tenant_id,opportunity_id,organization_id,actor_id,patch,reason,created_at
        ) values(?,?,?,?,?,?,?,?)`,
      )
      .run(
        override.id,
        tenantId,
        override.opportunityId,
        override.organizationId,
        override.actorId,
        JSON.stringify(override.patch),
        override.reason,
        override.createdAt,
      );
  }

  async listOpportunityOverrides(
    organizationId: string,
    tenantId = this.defaultTenantId,
  ): Promise<OpportunityOverride[]> {
    const rows = this.db
      .prepare(
        `select * from opportunity_overrides
         where tenant_id=? and organization_id=? and revoked_at is null order by created_at`,
      )
      .all(tenantId, organizationId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      tenantId: String(row.tenant_id),
      opportunityId: String(row.opportunity_id),
      organizationId: String(row.organization_id),
      actorId: String(row.actor_id),
      patch: parseJsonSafe(String(row.patch), {}),
      reason: String(row.reason),
      createdAt: String(row.created_at),
    }));
  }

  async getConnectorState(
    connector: string,
    scope: string,
    tenantId = this.defaultTenantId,
  ): Promise<{
    cursor?: string;
    metadata: Record<string, unknown>;
  }> {
    const row = this.db
      .prepare(`select * from connector_state where tenant_id=? and connector=? and scope=?`)
      .get(tenantId, connector, scope) as Record<string, unknown> | undefined;
    return row
      ? {
          cursor: row.cursor ? String(row.cursor) : undefined,
          metadata: parseJsonSafe(String(row.metadata), {}),
        }
      : { metadata: {} };
  }

  async setConnectorState(
    connector: string,
    scope: string,
    cursor?: string,
    metadata: Record<string, unknown> = {},
    tenantId = this.defaultTenantId,
  ): Promise<void> {
    this.db
      .prepare(
        `insert into connector_state(tenant_id,connector,scope,cursor,metadata,updated_at)
      values(?,?,?,?,?,?) on conflict(tenant_id,connector,scope) do update set
      cursor=excluded.cursor,metadata=excluded.metadata,updated_at=excluded.updated_at`,
      )
      .run(tenantId, connector, scope, cursor ?? null, JSON.stringify(metadata), nowIso());
  }

  async getSourceVersionStatus(
    versionId: string,
    tenantId = this.defaultTenantId,
  ): Promise<
    | {
        status: SourceVersionStatus;
        attemptCount: number;
        lastError?: string;
      }
    | undefined
  > {
    const row = this.db
      .prepare(
        `select status,attempt_count,last_error from source_versions
      where tenant_id=? and id=?`,
      )
      .get(tenantId, versionId) as Record<string, unknown> | undefined;
    return row
      ? {
          status: String(row.status) as SourceVersionStatus,
          attemptCount: Number(row.attempt_count),
          lastError: row.last_error ? String(row.last_error) : undefined,
        }
      : undefined;
  }

  private mapOrganization(row: Record<string, unknown>): Organization {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      name: String(row.name),
      school: String(row.school),
      heelLifeUrl: row.heel_life_url ? String(row.heel_life_url) : undefined,
      websiteUrl: row.website_url ? String(row.website_url) : undefined,
      instagramHandle: row.instagram_handle ? String(row.instagram_handle) : undefined,
      linkedinUrl: row.linkedin_url ? String(row.linkedin_url) : undefined,
    };
  }
}

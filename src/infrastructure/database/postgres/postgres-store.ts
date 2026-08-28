import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type { RecruitingRepository } from '../../../application/ports/recruiting-repository';
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
} from '../../../domain/models';
import { stableId } from '../../../lib/util';

function hashSource(source: SourceItem): string {
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

function identity(source: SourceItem): string {
  return source.externalId ?? source.url ?? source.id;
}

export interface PostgresStoreOptions {
  connectionString: string;
  pool?: Pool;
  maxConnections?: number;
  statementTimeoutMs?: number;
  defaultTenantId?: string;
}

export class PostgresStore implements RecruitingRepository {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  private readonly transactions = new AsyncLocalStorage<PoolClient>();
  private readonly statementTimeoutMs: number;
  private readonly defaultTenantId: string;

  constructor(options: PostgresStoreOptions) {
    this.statementTimeoutMs = options.statementTimeoutMs ?? 5_000;
    this.defaultTenantId = options.defaultTenantId ?? DEFAULT_TENANT_ID;
    this.ownsPool = !options.pool;
    this.pool =
      options.pool ??
      new Pool({
        connectionString: options.connectionString,
        max: options.maxConnections ?? 10,
        statement_timeout: this.statementTimeoutMs,
        idle_in_transaction_session_timeout: 10_000,
        application_name: 'recruiting-os',
      });
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    if (this.transactions.getStore()) return operation();
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`set local statement_timeout = '${this.statementTimeoutMs}ms'`);
      const result = await this.transactions.run(client, operation);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async upsertOrganization(
    organization: Organization,
    tenantId = organization.tenantId ?? this.defaultTenantId,
  ): Promise<void> {
    await this.transaction(async () => {
      const client = this.client();
      await client.query(`insert into tenants(id,name) values($1,$1) on conflict(id) do nothing`, [
        tenantId,
      ]);
      await this.setTenant(client, tenantId);
      await client.query(
        `insert into organizations(
          tenant_id,id,name,school,heel_life_url,website_url,instagram_handle,linkedin_url
        ) values($1,$2,$3,$4,$5,$6,$7,$8)
        on conflict(tenant_id,id) do update set
          name=excluded.name,school=excluded.school,
          heel_life_url=coalesce(excluded.heel_life_url,organizations.heel_life_url),
          website_url=coalesce(excluded.website_url,organizations.website_url),
          instagram_handle=coalesce(excluded.instagram_handle,organizations.instagram_handle),
          linkedin_url=coalesce(excluded.linkedin_url,organizations.linkedin_url),updated_at=now()`,
        [
          tenantId,
          organization.id,
          organization.name,
          organization.school,
          organization.heelLifeUrl ?? null,
          organization.websiteUrl ?? null,
          organization.instagramHandle ?? null,
          organization.linkedinUrl ?? null,
        ],
      );
    });
  }

  async getOrganization(
    id: string,
    tenantId = this.defaultTenantId,
  ): Promise<Organization | undefined> {
    return this.withTenant(tenantId, async (client) => {
      const row = (
        await client.query('select * from organizations where tenant_id=$1 and id=$2', [
          tenantId,
          id,
        ])
      ).rows[0];
      return row ? this.mapOrganization(row) : undefined;
    });
  }

  async listOrganizations(tenantId = this.defaultTenantId): Promise<Organization[]> {
    return this.withTenant(tenantId, async (client) =>
      (
        await client.query('select * from organizations where tenant_id=$1 order by name', [
          tenantId,
        ])
      ).rows.map((row) => this.mapOrganization(row)),
    );
  }

  async stageSource(
    source: SourceItem,
    tenantId = source.tenantId ?? this.defaultTenantId,
  ): Promise<StageSourceResult> {
    const sourceIdentity = identity(source);
    const sourceId = stableId(
      'src',
      `${tenantId}:${source.organizationId}:${source.sourceType}:${sourceIdentity}`,
    );
    const contentHash = hashSource(source);
    const versionId = stableId('srcv', `${sourceId}:${contentHash}`);
    return this.withTenant(tenantId, async (client) => {
      await client.query(
        `insert into sources(
          id,tenant_id,organization_id,source_type,identity_key,external_id,url,title
        ) values($1,$2,$3,$4,$5,$6,$7,$8)
        on conflict(tenant_id,organization_id,source_type,identity_key) do update set
          external_id=excluded.external_id,url=excluded.url,title=excluded.title,last_seen_at=now()`,
        [
          sourceId,
          tenantId,
          source.organizationId,
          source.sourceType,
          sourceIdentity,
          source.externalId ?? null,
          source.url ?? null,
          source.title ?? null,
        ],
      );
      await client.query(
        `insert into source_versions(
          id,source_id,tenant_id,organization_id,content_hash,raw_text,media,published_at,
          fetched_at,metadata,status
        ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'received')
        on conflict(source_id,content_hash) do nothing`,
        [
          versionId,
          sourceId,
          tenantId,
          source.organizationId,
          contentHash,
          source.rawText,
          JSON.stringify(source.media),
          source.publishedAt ?? null,
          source.fetchedAt,
          JSON.stringify(source.metadata ?? {}),
        ],
      );
      if (source.contributorUserId) {
        const contributor = await client.query(
          `insert into source_version_contributors(tenant_id,source_version_id,user_id)
           select $1,$2,$3 from memberships where tenant_id=$1 and user_id=$3
           on conflict do nothing`,
          [tenantId, versionId, source.contributorUserId],
        );
        if (contributor.rowCount !== 1) {
          const existing = await client.query(
            `select 1 from source_version_contributors
             where tenant_id=$1 and source_version_id=$2 and user_id=$3`,
            [tenantId, versionId, source.contributorUserId],
          );
          if (!existing.rowCount) throw new Error('Source contributor is not a tenant member');
        }
      }
      const row = (
        await client.query<{ status: SourceVersionStatus; attempt_count: number }>(
          'select status,attempt_count from source_versions where tenant_id=$1 and id=$2',
          [tenantId, versionId],
        )
      ).rows[0];
      if (!row) throw new Error('Failed to stage source version');
      const shouldProcess = row.status === 'received' || row.status === 'retryable_failed';
      if (shouldProcess) {
        await client.query(
          `update source_versions set status='queued',next_attempt_at=null where tenant_id=$1 and id=$2`,
          [tenantId, versionId],
        );
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

  async markSourceProcessing(versionId: string, tenantId = this.defaultTenantId): Promise<number> {
    return this.withTenant(tenantId, async (client) => {
      const row = (
        await client.query<{ attempt_count: number }>(
          `update source_versions set status='processing',attempt_count=attempt_count+1,
          started_at=now(),last_error=null
         where tenant_id=$1 and id=$2 and status in ('queued','retryable_failed','received')
         returning attempt_count`,
          [tenantId, versionId],
        )
      ).rows[0];
      if (!row) throw new Error('Source version is not ready for processing');
      return row.attempt_count;
    });
  }

  async markSourceSucceeded(versionId: string, tenantId = this.defaultTenantId): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `update source_versions set status='succeeded',completed_at=now(),next_attempt_at=null,last_error=null
         where tenant_id=$1 and id=$2`,
        [tenantId, versionId],
      );
    });
  }

  async markSourceFailed(
    versionId: string,
    failure: ProcessingFailure,
    tenantId = this.defaultTenantId,
  ): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `update source_versions set status=$3,last_error=$4,next_attempt_at=$5,completed_at=now()
         where tenant_id=$1 and id=$2`,
        [
          tenantId,
          versionId,
          failure.retryable ? 'retryable_failed' : 'terminal_failed',
          failure.message.slice(0, 500),
          failure.nextAttemptAt ?? null,
        ],
      );
    });
  }

  async getSource(id: string, tenantId = this.defaultTenantId): Promise<SourceItem | undefined> {
    return this.withTenant(tenantId, async (client) => {
      const row = (
        await client.query(
          `select v.id as version_id,v.organization_id,s.source_type,s.external_id,s.url,s.title,
          v.raw_text,v.media,v.published_at,v.fetched_at,v.metadata,v.tenant_id
         from source_versions v join sources s on s.id=v.source_id
         where v.tenant_id=$1 and (v.id=$2 or s.id=$2) order by v.fetched_at desc limit 1`,
          [tenantId, id],
        )
      ).rows[0];
      return row
        ? {
            id: row.version_id,
            tenantId: row.tenant_id,
            organizationId: row.organization_id,
            sourceType: row.source_type as SourceType,
            externalId: row.external_id ?? undefined,
            url: row.url ?? undefined,
            title: row.title ?? undefined,
            rawText: row.raw_text,
            media: row.media,
            publishedAt: row.published_at?.toISOString(),
            fetchedAt: row.fetched_at.toISOString(),
            metadata: row.metadata,
          }
        : undefined;
    });
  }

  async putClaims(claims: Claim[], tenantId = this.defaultTenantId): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      for (const claim of claims) {
        await client.query(
          `insert into claims(
            id,tenant_id,organization_id,source_version_id,field,value,confidence,published_at,
            extracted_at,supersedes,evidence,temporal_precision
          ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          on conflict(source_version_id,field,value) do update set
            confidence=excluded.confidence,evidence=excluded.evidence,extracted_at=excluded.extracted_at`,
          [
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
          ],
        );
      }
    });
  }

  async listClaims(organizationId: string, tenantId = this.defaultTenantId): Promise<Claim[]> {
    return this.withTenant(tenantId, async (client) =>
      (
        await client.query(
          `select * from claims where tenant_id=$1 and organization_id=$2
         order by coalesce(published_at,extracted_at)`,
          [tenantId, organizationId],
        )
      ).rows.map((row) => ({
        id: row.id,
        tenantId: row.tenant_id,
        organizationId: row.organization_id,
        sourceItemId: row.source_version_id,
        field: row.field,
        value: row.value,
        confidence: row.confidence,
        publishedAt: row.published_at?.toISOString(),
        extractedAt: row.extracted_at.toISOString(),
        supersedes: row.supersedes,
        evidence: row.evidence ?? undefined,
        temporalPrecision: row.temporal_precision ?? undefined,
      })),
    );
  }

  async replaceOpportunities(
    organizationId: string,
    opportunities: Opportunity[],
    tenantId = this.defaultTenantId,
  ): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query('delete from opportunities where tenant_id=$1 and organization_id=$2', [
        tenantId,
        organizationId,
      ]);
      for (const opportunity of opportunities) {
        await client.query(
          `insert into opportunities(
            id,tenant_id,organization_id,kind,title,deadline_at,starts_at,url,role,confidence,stale,
            source_claim_ids,explanation,resolver_version,resolved_at,deadline_precision,starts_at_precision
          ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [
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
            opportunity.stale,
            JSON.stringify(opportunity.sourceClaimIds),
            opportunity.explanation,
            opportunity.resolverVersion ?? 'resolver-v2',
            opportunity.resolvedAt,
            opportunity.deadlinePrecision ?? null,
            opportunity.startsAtPrecision ?? null,
          ],
        );
      }
    });
  }

  async listOpportunities(
    organizationId?: string,
    tenantId = this.defaultTenantId,
  ): Promise<Opportunity[]> {
    return this.withTenant(tenantId, async (client) => {
      const result = organizationId
        ? await client.query(
            `select * from opportunities where tenant_id=$1 and organization_id=$2
             order by coalesce(deadline_at,starts_at)`,
            [tenantId, organizationId],
          )
        : await client.query(
            `select * from opportunities where tenant_id=$1 order by coalesce(deadline_at,starts_at)`,
            [tenantId],
          );
      return result.rows.map((row) => ({
        id: row.id,
        tenantId: row.tenant_id,
        organizationId: row.organization_id,
        kind: row.kind,
        title: row.title,
        deadlineAt: row.deadline_at?.toISOString(),
        startsAt: row.starts_at?.toISOString(),
        url: row.url ?? undefined,
        role: row.role ?? undefined,
        confidence: row.confidence,
        stale: row.stale,
        sourceClaimIds: row.source_claim_ids,
        explanation: row.explanation,
        resolverVersion: row.resolver_version,
        resolvedAt: row.resolved_at.toISOString(),
        deadlinePrecision: row.deadline_precision ?? undefined,
        startsAtPrecision: row.starts_at_precision ?? undefined,
      }));
    });
  }

  async putOpportunityOverride(
    override: OpportunityOverride,
    tenantId = override.tenantId ?? this.defaultTenantId,
  ): Promise<void> {
    if (!override.actorId) throw new Error('Opportunity override actor is required');
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `insert into opportunity_overrides(
          id,tenant_id,opportunity_id,organization_id,actor_id,patch,reason,created_at
        ) values($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          override.id,
          tenantId,
          override.opportunityId,
          override.organizationId,
          override.actorId,
          JSON.stringify(override.patch),
          override.reason,
          override.createdAt,
        ],
      );
    });
  }

  async listOpportunityOverrides(
    organizationId: string,
    tenantId = this.defaultTenantId,
  ): Promise<OpportunityOverride[]> {
    return this.withTenant(tenantId, async (client) =>
      (
        await client.query(
          `select * from opportunity_overrides
           where tenant_id=$1 and organization_id=$2 and revoked_at is null order by created_at`,
          [tenantId, organizationId],
        )
      ).rows.map((row) => ({
        id: row.id,
        tenantId: row.tenant_id,
        opportunityId: row.opportunity_id,
        organizationId: row.organization_id,
        actorId: row.actor_id ?? undefined,
        patch: row.patch,
        reason: row.reason,
        createdAt: row.created_at.toISOString(),
      })),
    );
  }

  async getConnectorState(
    connector: string,
    scope: string,
    tenantId = this.defaultTenantId,
  ): Promise<{ cursor?: string; metadata: Record<string, unknown> }> {
    return this.withTenant(tenantId, async (client) => {
      const row = (
        await client.query(
          `select cursor,metadata from connector_state where tenant_id=$1 and connector=$2 and scope=$3`,
          [tenantId, connector, scope],
        )
      ).rows[0];
      return row ? { cursor: row.cursor ?? undefined, metadata: row.metadata } : { metadata: {} };
    });
  }

  async setConnectorState(
    connector: string,
    scope: string,
    cursor?: string,
    metadata: Record<string, unknown> = {},
    tenantId = this.defaultTenantId,
    ownerUserId?: string,
  ): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        `insert into connector_state(tenant_id,connector,scope,cursor,metadata,owner_user_id)
         values($1,$2,$3,$4,$5,$6) on conflict(tenant_id,connector,scope) do update set
         cursor=excluded.cursor,metadata=excluded.metadata,
         owner_user_id=excluded.owner_user_id,updated_at=now()`,
        [tenantId, connector, scope, cursor ?? null, JSON.stringify(metadata), ownerUserId ?? null],
      );
    });
  }

  private client(): PoolClient {
    const client = this.transactions.getStore();
    if (!client) throw new Error('Database operation requires a transaction');
    return client;
  }

  private async setTenant(client: PoolClient, tenantId: string): Promise<void> {
    await client.query(`select set_config('app.tenant_id',$1,true)`, [tenantId]);
  }

  private async withTenant<T>(
    tenantId: string,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const active = this.transactions.getStore();
    if (active) {
      await this.setTenant(active, tenantId);
      return operation(active);
    }
    return this.transaction(async () => {
      const client = this.client();
      await this.setTenant(client, tenantId);
      return operation(client);
    });
  }

  private mapOrganization(row: QueryResultRow): Organization {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      name: row.name,
      school: row.school,
      heelLifeUrl: row.heel_life_url ?? undefined,
      websiteUrl: row.website_url ?? undefined,
      instagramHandle: row.instagram_handle ?? undefined,
      linkedinUrl: row.linkedin_url ?? undefined,
    };
  }
}

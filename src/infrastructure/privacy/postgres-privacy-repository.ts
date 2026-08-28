import { Pool, type PoolClient } from 'pg';
import type {
  AccountDataExport,
  AccountErasureResult,
  PrivacyRepository,
} from '../../application/ports/privacy-repository';
import type { Role, SourceType, SourceVersionStatus } from '../../domain/models';
import { PRIVATE_SOURCE_TYPES } from '../../domain/data-policy';
import { stableId } from '../../lib/util';

const privateSourceTypes: string[] = [...PRIVATE_SOURCE_TYPES];

interface AccountRow {
  id: string;
  issuer: string;
  subject: string;
  email: string | null;
  display_name: string | null;
  created_at: Date;
  roles: Role[];
  organization_ids: string[];
  membership_created_at: Date;
}

interface ConnectorRow {
  provider: string;
  scopes: string[];
  expires_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

interface ContributionRow {
  source_version_id: string;
  organization_id: string;
  source_type: SourceType;
  title: string | null;
  url: string | null;
  published_at: Date | null;
  fetched_at: Date;
  status: SourceVersionStatus;
  shared: boolean;
}

interface ActivityRow {
  action: string;
  resource_type: string;
  resource_id: string | null;
  created_at: Date;
}

export class PostgresPrivacyRepository implements PrivacyRepository {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;

  constructor(connection: string | Pool, maxConnections = 3) {
    this.ownsPool = typeof connection === 'string';
    this.pool =
      typeof connection === 'string'
        ? new Pool({
            connectionString: connection,
            max: maxConnections,
            statement_timeout: 5_000,
            application_name: 'recruiting-os-privacy',
          })
        : connection;
  }

  async exportAccount(tenantId: string, userId: string): Promise<AccountDataExport | undefined> {
    return this.withTenant(tenantId, async (client) => {
      const account = (
        await client.query<AccountRow>(
          `select u.id,u.issuer,u.subject,u.email,u.display_name,u.created_at,
                  m.roles,m.organization_ids,m.created_at as membership_created_at
           from users u join memberships m on m.user_id=u.id
           where m.tenant_id=$1 and u.id=$2`,
          [tenantId, userId],
        )
      ).rows[0];
      if (!account) return undefined;
      const connectors = (
        await client.query<ConnectorRow>(
          `select provider,scopes,expires_at,revoked_at,created_at
           from credentials where tenant_id=$1 and user_id=$2 order by provider`,
          [tenantId, userId],
        )
      ).rows;
      const contributions = (
        await client.query<ContributionRow>(
          `select sv.id as source_version_id,sv.organization_id,s.source_type,s.title,s.url,
                  sv.published_at,sv.fetched_at,sv.status,
                  exists(select 1 from source_version_contributors other
                         where other.tenant_id=svc.tenant_id
                           and other.source_version_id=svc.source_version_id
                           and other.user_id<>svc.user_id) as shared
           from source_version_contributors svc
           join source_versions sv on sv.id=svc.source_version_id and sv.tenant_id=svc.tenant_id
           join sources s on s.id=sv.source_id and s.tenant_id=sv.tenant_id
           where svc.tenant_id=$1 and svc.user_id=$2
           order by svc.created_at desc`,
          [tenantId, userId],
        )
      ).rows;
      const activity = (
        await client.query<ActivityRow>(
          `select action,resource_type,resource_id,created_at
           from audit_events where tenant_id=$1 and actor_id=$2 order by created_at desc`,
          [tenantId, userId],
        )
      ).rows;
      return {
        generatedAt: new Date().toISOString(),
        identity: {
          id: account.id,
          issuer: account.issuer,
          subject: account.subject,
          email: account.email ?? undefined,
          displayName: account.display_name ?? undefined,
          createdAt: account.created_at.toISOString(),
        },
        membership: {
          tenantId,
          roles: account.roles,
          organizationIds: account.organization_ids,
          createdAt: account.membership_created_at.toISOString(),
        },
        connectors: connectors.map((row) => ({
          provider: row.provider,
          scopes: row.scopes,
          expiresAt: row.expires_at?.toISOString(),
          revokedAt: row.revoked_at?.toISOString(),
          createdAt: row.created_at.toISOString(),
        })),
        contributions: contributions.map((row) => ({
          sourceVersionId: row.source_version_id,
          organizationId: row.organization_id,
          sourceType: row.source_type,
          title: privateSourceTypes.includes(row.source_type)
            ? undefined
            : (row.title ?? undefined),
          url: privateSourceTypes.includes(row.source_type) ? undefined : (row.url ?? undefined),
          publishedAt: row.published_at?.toISOString(),
          fetchedAt: row.fetched_at.toISOString(),
          status: row.status,
          shared: row.shared,
        })),
        activity: activity.map((row) => ({
          action: row.action,
          resourceType: row.resource_type,
          resourceId: row.resource_id ?? undefined,
          createdAt: row.created_at.toISOString(),
        })),
      };
    });
  }

  async eraseAccount(
    tenantId: string,
    userId: string,
    operationId: string,
  ): Promise<AccountErasureResult> {
    return this.withTenant(tenantId, async (client) => {
      const membership = await client.query(
        'select 1 from memberships where tenant_id=$1 and user_id=$2 for update',
        [tenantId, userId],
      );
      if (!membership.rowCount) return emptyErasure();

      const contributedPrivateVersions = (
        await client.query<{ id: string; organization_id: string }>(
          `select sv.id,sv.organization_id
           from source_version_contributors svc
           join source_versions sv on sv.id=svc.source_version_id and sv.tenant_id=svc.tenant_id
           join sources s on s.id=sv.source_id and s.tenant_id=sv.tenant_id
           where svc.tenant_id=$1 and svc.user_id=$2 and s.source_type=any($3::text[])
           for update of sv`,
          [tenantId, userId, privateSourceTypes],
        )
      ).rows;
      const removedContributions = await client.query(
        'delete from source_version_contributors where tenant_id=$1 and user_id=$2',
        [tenantId, userId],
      );
      const candidateIds = contributedPrivateVersions.map((row) => row.id);
      const orphanedPrivateVersions = candidateIds.length
        ? (
            await client.query<{ id: string; organization_id: string }>(
              `select sv.id,sv.organization_id from source_versions sv
               where sv.tenant_id=$1 and sv.id=any($2::text[])
                 and not exists(select 1 from source_version_contributors svc
                                where svc.tenant_id=sv.tenant_id and svc.source_version_id=sv.id)`,
              [tenantId, candidateIds],
            )
          ).rows
        : [];
      const privateVersionIds = orphanedPrivateVersions.map((row) => row.id);
      const claimsDeleted = privateVersionIds.length
        ? await client.query(
            'delete from claims where tenant_id=$1 and source_version_id=any($2::text[])',
            [tenantId, privateVersionIds],
          )
        : { rowCount: 0 };
      const versionsDeleted = privateVersionIds.length
        ? await client.query(
            'delete from source_versions where tenant_id=$1 and id=any($2::text[])',
            [tenantId, privateVersionIds],
          )
        : { rowCount: 0 };
      await client.query(
        `delete from sources s where s.tenant_id=$1
         and not exists(select 1 from source_versions sv where sv.source_id=s.id)`,
        [tenantId],
      );

      const credentials = await client.query(
        'delete from credentials where tenant_id=$1 and user_id=$2',
        [tenantId, userId],
      );
      const sessions = await client.query(
        'delete from sessions where tenant_id=$1 and user_id=$2',
        [tenantId, userId],
      );
      const jobs = await client.query(
        `delete from jobs where tenant_id=$1 and payload->>'userId'=$2`,
        [tenantId, userId],
      );
      const connectorStates = await client.query(
        `delete from connector_state where tenant_id=$1 and (scope=$2 or scope like $2 || ':%')`,
        [tenantId, userId],
      );
      await client.query(
        'update audit_events set actor_id=null where tenant_id=$1 and actor_id=$2',
        [tenantId, userId],
      );
      await client.query(
        'update opportunity_overrides set actor_id=null where tenant_id=$1 and actor_id=$2',
        [tenantId, userId],
      );
      const deletedMembership = await client.query(
        'delete from memberships where tenant_id=$1 and user_id=$2',
        [tenantId, userId],
      );
      const deletedIdentity = await client.query(
        'delete from users where id=$1 and membership_count=0',
        [userId],
      );
      const affectedOrganizationIds = [
        ...new Set(orphanedPrivateVersions.map((row) => row.organization_id)),
      ];
      const reconciliationJobIds: string[] = [];
      for (const organizationId of affectedOrganizationIds) {
        const idempotencyKey = `privacy:${userId}:${operationId}:${organizationId}`;
        const jobId = stableId('job', `${tenantId}:privacy.reconcile:${idempotencyKey}`);
        await client.query(
          `insert into jobs(
             id,tenant_id,type,idempotency_key,payload,status,priority,max_attempts,available_at
           ) values($1,$2,'privacy.reconcile',$3,$4,'queued',10,5,now())`,
          [jobId, tenantId, idempotencyKey, JSON.stringify({ organizationId })],
        );
        reconciliationJobIds.push(jobId);
      }
      const result: AccountErasureResult = {
        membershipDeleted: deletedMembership.rowCount === 1,
        identityDeleted: deletedIdentity.rowCount === 1,
        credentialsDeleted: credentials.rowCount ?? 0,
        sessionsDeleted: sessions.rowCount ?? 0,
        jobsDeleted: jobs.rowCount ?? 0,
        connectorStatesDeleted: connectorStates.rowCount ?? 0,
        contributionsRemoved: removedContributions.rowCount ?? 0,
        privateSourceVersionsDeleted: versionsDeleted.rowCount ?? 0,
        claimsDeleted: claimsDeleted.rowCount ?? 0,
        affectedOrganizationIds,
        reconciliationJobIds,
      };
      await client.query(
        `insert into audit_events(
           id,tenant_id,actor_id,action,resource_type,request_id,metadata
         ) values($1,$2,null,'privacy.erase','account',$3,$4)`,
        [
          stableId('aud', `${tenantId}:privacy.erase:${userId}:${operationId}`),
          tenantId,
          operationId,
          JSON.stringify(result),
        ],
      );
      return result;
    });
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  private async withTenant<T>(
    tenantId: string,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id',$1,true)`, [tenantId]);
      const result = await operation(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
}

function emptyErasure(): AccountErasureResult {
  return {
    membershipDeleted: false,
    identityDeleted: false,
    credentialsDeleted: 0,
    sessionsDeleted: 0,
    jobsDeleted: 0,
    connectorStatesDeleted: 0,
    contributionsRemoved: 0,
    privateSourceVersionsDeleted: 0,
    claimsDeleted: 0,
    affectedOrganizationIds: [],
    reconciliationJobIds: [],
  };
}

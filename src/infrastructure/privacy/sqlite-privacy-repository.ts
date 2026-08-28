import type {
  AccountDataExport,
  AccountErasureResult,
  PrivacyRepository,
} from '../../application/ports/privacy-repository';
import type { Role, SourceType, SourceVersionStatus } from '../../domain/models';
import { PRIVATE_SOURCE_TYPES } from '../../domain/data-policy';
import { nowIso, parseJsonSafe, stableId } from '../../lib/util';
import type { Store } from '../../store';

const privateSourceTypes = new Set<string>(PRIVATE_SOURCE_TYPES);

export class SqlitePrivacyRepository implements PrivacyRepository {
  constructor(private readonly store: Store) {}

  async exportAccount(tenantId: string, userId: string): Promise<AccountDataExport | undefined> {
    const account = this.store.db
      .prepare(
        `select u.*,m.roles,m.organization_ids,m.created_at as membership_created_at
         from users u join memberships m on m.user_id=u.id
         where m.tenant_id=? and u.id=?`,
      )
      .get(tenantId, userId) as Record<string, unknown> | undefined;
    if (!account) return undefined;
    const connectors = this.store.db
      .prepare(
        `select provider,scopes,expires_at,revoked_at,created_at
         from credentials where tenant_id=? and user_id=? order by provider`,
      )
      .all(tenantId, userId) as Record<string, unknown>[];
    const contributions = this.store.db
      .prepare(
        `select sv.id as source_version_id,sv.organization_id,s.source_type,s.title,s.url,
                sv.published_at,sv.fetched_at,sv.status,
                exists(select 1 from source_version_contributors other
                       where other.tenant_id=svc.tenant_id
                         and other.source_version_id=svc.source_version_id
                         and other.user_id<>svc.user_id) as shared
         from source_version_contributors svc
         join source_versions sv on sv.id=svc.source_version_id and sv.tenant_id=svc.tenant_id
         join sources s on s.id=sv.source_id and s.tenant_id=sv.tenant_id
         where svc.tenant_id=? and svc.user_id=? order by svc.created_at desc`,
      )
      .all(tenantId, userId) as Record<string, unknown>[];
    const activity = this.store.db
      .prepare(
        `select action,resource_type,resource_id,created_at from audit_events
         where tenant_id=? and actor_id=? order by created_at desc`,
      )
      .all(tenantId, userId) as Record<string, unknown>[];
    return {
      generatedAt: nowIso(),
      identity: {
        id: String(account.id),
        issuer: String(account.issuer),
        subject: String(account.subject),
        email: account.email ? String(account.email) : undefined,
        displayName: account.display_name ? String(account.display_name) : undefined,
        createdAt: String(account.created_at),
      },
      membership: {
        tenantId,
        roles: parseJsonSafe<Role[]>(String(account.roles), []),
        organizationIds: parseJsonSafe<string[]>(String(account.organization_ids), []),
        createdAt: String(account.membership_created_at),
      },
      connectors: connectors.map((row) => ({
        provider: String(row.provider),
        scopes: parseJsonSafe<string[]>(String(row.scopes), []),
        expiresAt: row.expires_at ? String(row.expires_at) : undefined,
        revokedAt: row.revoked_at ? String(row.revoked_at) : undefined,
        createdAt: String(row.created_at),
      })),
      contributions: contributions.map((row) => ({
        sourceVersionId: String(row.source_version_id),
        organizationId: String(row.organization_id),
        sourceType: String(row.source_type) as SourceType,
        title: privateSourceTypes.has(String(row.source_type))
          ? undefined
          : row.title
            ? String(row.title)
            : undefined,
        url: privateSourceTypes.has(String(row.source_type))
          ? undefined
          : row.url
            ? String(row.url)
            : undefined,
        publishedAt: row.published_at ? String(row.published_at) : undefined,
        fetchedAt: String(row.fetched_at),
        status: String(row.status) as SourceVersionStatus,
        shared: Boolean(row.shared),
      })),
      activity: activity.map((row) => ({
        action: String(row.action),
        resourceType: String(row.resource_type),
        resourceId: row.resource_id ? String(row.resource_id) : undefined,
        createdAt: String(row.created_at),
      })),
    };
  }

  async eraseAccount(
    tenantId: string,
    userId: string,
    operationId: string,
  ): Promise<AccountErasureResult> {
    return this.store.transaction(async () => {
      const membership = this.store.db
        .prepare('select 1 from memberships where tenant_id=? and user_id=?')
        .get(tenantId, userId);
      if (!membership) return emptyErasure();
      const contributed = this.store.db
        .prepare(
          `select distinct sv.id,sv.organization_id,s.source_type
           from source_version_contributors svc
           join source_versions sv on sv.id=svc.source_version_id and sv.tenant_id=svc.tenant_id
           join sources s on s.id=sv.source_id and s.tenant_id=sv.tenant_id
           where svc.tenant_id=? and svc.user_id=?`,
        )
        .all(tenantId, userId) as Array<{
        id: string;
        organization_id: string;
        source_type: string;
      }>;
      const contributionsRemoved = Number(
        this.store.db
          .prepare('delete from source_version_contributors where tenant_id=? and user_id=?')
          .run(tenantId, userId).changes,
      );
      const orphaned = contributed.filter(
        (row) =>
          privateSourceTypes.has(row.source_type) &&
          !this.store.db
            .prepare(
              `select 1 from source_version_contributors
               where tenant_id=? and source_version_id=? limit 1`,
            )
            .get(tenantId, row.id),
      );
      let claimsDeleted = 0;
      let privateSourceVersionsDeleted = 0;
      for (const row of orphaned) {
        claimsDeleted += Number(
          this.store.db
            .prepare('delete from claims where tenant_id=? and source_version_id=?')
            .run(tenantId, row.id).changes,
        );
        privateSourceVersionsDeleted += Number(
          this.store.db
            .prepare('delete from source_versions where tenant_id=? and id=?')
            .run(tenantId, row.id).changes,
        );
      }
      this.store.db
        .prepare(
          `delete from sources where tenant_id=?
           and not exists(select 1 from source_versions where source_id=sources.id)`,
        )
        .run(tenantId);
      const credentialsDeleted = Number(
        this.store.db
          .prepare('delete from credentials where tenant_id=? and user_id=?')
          .run(tenantId, userId).changes,
      );
      const sessionsDeleted = Number(
        this.store.db
          .prepare('delete from sessions where tenant_id=? and user_id=?')
          .run(tenantId, userId).changes,
      );
      const jobRows = this.store.db
        .prepare('select id,payload from jobs where tenant_id=?')
        .all(tenantId) as Array<{ id: string; payload: string }>;
      let jobsDeleted = 0;
      const deleteJob = this.store.db.prepare('delete from jobs where tenant_id=? and id=?');
      for (const row of jobRows) {
        const payload = parseJsonSafe<Record<string, unknown>>(row.payload, {});
        if (payload.userId === userId)
          jobsDeleted += Number(deleteJob.run(tenantId, row.id).changes);
      }
      const connectorStatesDeleted = Number(
        this.store.db
          .prepare(`delete from connector_state where tenant_id=? and (scope=? or scope like ?)`)
          .run(tenantId, userId, `${userId}:%`).changes,
      );
      this.store.db
        .prepare('update audit_events set actor_id=null where tenant_id=? and actor_id=?')
        .run(tenantId, userId);
      this.store.db
        .prepare('update opportunity_overrides set actor_id=null where tenant_id=? and actor_id=?')
        .run(tenantId, userId);
      const membershipDeleted =
        Number(
          this.store.db
            .prepare('delete from memberships where tenant_id=? and user_id=?')
            .run(tenantId, userId).changes,
        ) === 1;
      const hasMembership = this.store.db
        .prepare('select 1 from memberships where user_id=? limit 1')
        .get(userId);
      const identityDeleted = hasMembership
        ? false
        : Number(this.store.db.prepare('delete from users where id=?').run(userId).changes) === 1;
      const affectedOrganizationIds = [...new Set(orphaned.map((row) => row.organization_id))];
      const reconciliationJobIds: string[] = [];
      const createdAt = nowIso();
      for (const organizationId of affectedOrganizationIds) {
        const idempotencyKey = `privacy:${userId}:${operationId}:${organizationId}`;
        const jobId = stableId('job', `${tenantId}:privacy.reconcile:${idempotencyKey}`);
        this.store.db
          .prepare(
            `insert into jobs(
               id,tenant_id,type,idempotency_key,payload,status,priority,max_attempts,
               available_at,created_at,updated_at
             ) values(?,?,'privacy.reconcile',?,?,'queued',10,5,?,?,?)`,
          )
          .run(
            jobId,
            tenantId,
            idempotencyKey,
            JSON.stringify({ organizationId }),
            createdAt,
            createdAt,
            createdAt,
          );
        reconciliationJobIds.push(jobId);
      }
      const result: AccountErasureResult = {
        membershipDeleted,
        identityDeleted,
        credentialsDeleted,
        sessionsDeleted,
        jobsDeleted,
        connectorStatesDeleted,
        contributionsRemoved,
        privateSourceVersionsDeleted,
        claimsDeleted,
        affectedOrganizationIds,
        reconciliationJobIds,
      };
      this.store.db
        .prepare(
          `insert into audit_events(
             id,tenant_id,actor_id,action,resource_type,request_id,metadata,created_at
           ) values(?,?,null,'privacy.erase','account',?,?,?)`,
        )
        .run(
          stableId('aud', `${tenantId}:privacy.erase:${userId}:${operationId}`),
          tenantId,
          operationId,
          JSON.stringify(result),
          createdAt,
        );
      return result;
    });
  }

  async close(): Promise<void> {}
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

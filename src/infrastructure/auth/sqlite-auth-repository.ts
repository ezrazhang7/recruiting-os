import type {
  AuthRepository,
  OidcIdentity,
  SessionAuthentication,
} from '../../application/ports/auth-repository';
import type { Role } from '../../domain/models';
import { nowIso, parseJsonSafe, stableId } from '../../lib/util';
import type { Store } from '../../store';

export class SqliteAuthRepository implements AuthRepository {
  constructor(private readonly store: Store) {}
  async upsertIdentity(
    identity: OidcIdentity,
    tenantId: string,
    defaultRoles: Role[] = ['student'],
  ): Promise<string> {
    const userId = stableId('usr', `${identity.issuer}:${identity.subject}`);
    const now = nowIso();
    await this.store.transaction(async () => {
      this.store.ensureTenant(tenantId, tenantId);
      this.store.db
        .prepare(
          `insert into users(id,issuer,subject,email,display_name,created_at,updated_at)
        values(?,?,?,?,?,?,?) on conflict(issuer,subject) do update set email=excluded.email,
        display_name=excluded.display_name,updated_at=excluded.updated_at`,
        )
        .run(
          userId,
          identity.issuer,
          identity.subject,
          identity.email ?? null,
          identity.displayName ?? null,
          now,
          now,
        );
      this.store.db
        .prepare(
          `insert into memberships(tenant_id,user_id,roles,organization_ids,created_at,updated_at)
        values(?,?,?,'[]',?,?) on conflict(tenant_id,user_id) do nothing`,
        )
        .run(tenantId, userId, JSON.stringify(defaultRoles), now, now);
      if (defaultRoles.includes('platform_admin')) {
        const membership = this.store.db
          .prepare('select roles from memberships where tenant_id=? and user_id=?')
          .get(tenantId, userId) as { roles: string };
        const roles = new Set(parseJsonSafe<Role[]>(membership.roles, []));
        roles.add('platform_admin');
        this.store.db
          .prepare('update memberships set roles=?,updated_at=? where tenant_id=? and user_id=?')
          .run(JSON.stringify([...roles]), now, tenantId, userId);
      }
    });
    return userId;
  }
  async createSession(input: {
    id: string;
    tenantId: string;
    userId: string;
    tokenHash: string;
    csrfHash: string;
    expiresAt: string;
  }): Promise<void> {
    const now = nowIso();
    this.store.db
      .prepare(
        `insert into sessions(id,tenant_id,user_id,token_hash,csrf_hash,expires_at,created_at,last_seen_at)
      values(?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.id,
        input.tenantId,
        input.userId,
        input.tokenHash,
        input.csrfHash,
        input.expiresAt,
        now,
        now,
      );
  }
  async authenticateSession(tokenHash: string): Promise<SessionAuthentication | undefined> {
    const row = this.store.db
      .prepare(
        `select s.*,m.roles,m.organization_ids from sessions s
      join memberships m on m.tenant_id=s.tenant_id and m.user_id=s.user_id
      where s.token_hash=? and s.revoked_at is null and s.expires_at>?`,
      )
      .get(tokenHash, nowIso()) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    this.store.db
      .prepare('update sessions set last_seen_at=? where id=?')
      .run(nowIso(), String(row.id));
    return {
      principal: {
        userId: String(row.user_id),
        tenantId: String(row.tenant_id),
        roles: parseJsonSafe(String(row.roles), []),
        organizationIds: parseJsonSafe(String(row.organization_ids), []),
        sessionId: String(row.id),
      },
      csrfHash: String(row.csrf_hash),
      expiresAt: String(row.expires_at),
    };
  }
  async revokeSession(sessionId: string, tenantId: string): Promise<void> {
    this.store.db
      .prepare(`update sessions set revoked_at=? where id=? and tenant_id=?`)
      .run(nowIso(), sessionId, tenantId);
  }
  async close(): Promise<void> {}
}

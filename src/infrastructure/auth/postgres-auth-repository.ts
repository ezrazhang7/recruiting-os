import { Pool } from 'pg';
import type {
  AuthRepository,
  OidcIdentity,
  SessionAuthentication,
} from '../../application/ports/auth-repository';
import type { Role } from '../../domain/models';
import { stableId } from '../../lib/util';

export class PostgresAuthRepository implements AuthRepository {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  constructor(connection: string | Pool, maxConnections = 5) {
    this.ownsPool = typeof connection === 'string';
    this.pool =
      typeof connection === 'string'
        ? new Pool({
            connectionString: connection,
            max: maxConnections,
            statement_timeout: 5_000,
            application_name: 'recruiting-os-auth',
          })
        : connection;
  }
  async upsertIdentity(
    identity: OidcIdentity,
    tenantId: string,
    defaultRoles: Role[] = ['student'],
  ): Promise<string> {
    const client = await this.pool.connect();
    const userId = stableId('usr', `${identity.issuer}:${identity.subject}`);
    try {
      await client.query('begin');
      await client.query(
        `insert into users(id,issuer,subject,email,display_name)
      values($1,$2,$3,$4,$5) on conflict(issuer,subject) do update set email=excluded.email,
      display_name=excluded.display_name,updated_at=now()`,
        [
          userId,
          identity.issuer,
          identity.subject,
          identity.email ?? null,
          identity.displayName ?? null,
        ],
      );
      await client.query('insert into tenants(id,name) values($1,$1) on conflict(id) do nothing', [
        tenantId,
      ]);
      await client.query(`select set_config('app.tenant_id',$1,true)`, [tenantId]);
      await client.query(
        `insert into memberships(tenant_id,user_id,roles) values($1,$2,$3)
        on conflict(tenant_id,user_id) do nothing`,
        [tenantId, userId, defaultRoles],
      );
      if (defaultRoles.includes('platform_admin')) {
        await client.query(
          `update memberships set
            roles=array(select distinct role from unnest(roles || $3::text[]) role),
            updated_at=now()
          where tenant_id=$1 and user_id=$2`,
          [tenantId, userId, defaultRoles],
        );
      }
      await client.query('commit');
      return userId;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
  async createSession(input: {
    id: string;
    tenantId: string;
    userId: string;
    tokenHash: string;
    csrfHash: string;
    expiresAt: string;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id',$1,true)`, [input.tenantId]);
      await client.query(
        `insert into sessions(id,tenant_id,user_id,token_hash,csrf_hash,expires_at)
        values($1,$2,$3,$4,$5,$6)`,
        [input.id, input.tenantId, input.userId, input.tokenHash, input.csrfHash, input.expiresAt],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
  async authenticateSession(tokenHash: string): Promise<SessionAuthentication | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const base = (await client.query('select * from app.authenticate_session($1)', [tokenHash]))
        .rows[0];
      if (!base) {
        await client.query('rollback');
        return undefined;
      }
      await client.query(`select set_config('app.tenant_id',$1,true)`, [base.tenant_id]);
      const membership = (
        await client.query(
          `select roles,organization_ids from memberships where tenant_id=$1 and user_id=$2`,
          [base.tenant_id, base.user_id],
        )
      ).rows[0];
      if (!membership) {
        await client.query('rollback');
        return undefined;
      }
      await client.query('update sessions set last_seen_at=now() where id=$1', [base.session_id]);
      await client.query('commit');
      return {
        principal: {
          userId: base.user_id,
          tenantId: base.tenant_id,
          roles: membership.roles,
          organizationIds: membership.organization_ids,
          sessionId: base.session_id,
        },
        csrfHash: base.csrf_hash,
        expiresAt: base.expires_at.toISOString(),
      };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
  async revokeSession(sessionId: string, tenantId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id',$1,true)`, [tenantId]);
      await client.query('update sessions set revoked_at=now() where id=$1 and tenant_id=$2', [
        sessionId,
        tenantId,
      ]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}

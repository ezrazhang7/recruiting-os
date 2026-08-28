import { Pool } from 'pg';
import type {
  CredentialRepository,
  StoredCredential,
} from '../../application/ports/credential-repository';

export class PostgresCredentialRepository implements CredentialRepository {
  private readonly pool: Pool;
  constructor(connectionString: string, max = 3) {
    this.pool = new Pool({
      connectionString,
      max,
      statement_timeout: 5_000,
      application_name: 'recruiting-os-credentials',
    });
  }
  async save(value: StoredCredential): Promise<void> {
    await this.withTenant(value.tenantId, async (client) => {
      await client.query(
        `insert into credentials(id,tenant_id,user_id,provider,encrypted_payload,key_version,scopes,expires_at)
    values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(tenant_id,user_id,provider) do update set encrypted_payload=excluded.encrypted_payload,key_version=excluded.key_version,scopes=excluded.scopes,expires_at=excluded.expires_at,revoked_at=null,updated_at=now()`,
        [
          value.id,
          value.tenantId,
          value.userId,
          value.provider,
          value.encryptedPayload,
          value.keyVersion,
          value.scopes,
          value.expiresAt ?? null,
        ],
      );
    });
  }
  async find(
    tenantId: string,
    userId: string,
    provider: string,
  ): Promise<StoredCredential | undefined> {
    return this.withTenant(tenantId, async (client) => {
      const row = (
        await client.query(
          'select * from credentials where tenant_id=$1 and user_id=$2 and provider=$3',
          [tenantId, userId, provider],
        )
      ).rows[0];
      return row
        ? {
            id: row.id,
            tenantId: row.tenant_id,
            userId: row.user_id,
            provider: row.provider,
            encryptedPayload: row.encrypted_payload,
            keyVersion: row.key_version,
            scopes: row.scopes,
            expiresAt: row.expires_at?.toISOString(),
            revokedAt: row.revoked_at?.toISOString(),
          }
        : undefined;
    });
  }
  async revoke(tenantId: string, userId: string, provider: string): Promise<void> {
    await this.withTenant(tenantId, async (client) => {
      await client.query(
        'update credentials set revoked_at=now(),updated_at=now() where tenant_id=$1 and user_id=$2 and provider=$3',
        [tenantId, userId, provider],
      );
    });
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
  private async withTenant<T>(
    tenantId: string,
    operation: (client: any) => Promise<T>,
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

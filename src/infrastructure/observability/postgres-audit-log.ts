import { Pool } from 'pg';
import type { AuditEvent, AuditLog } from '../../application/ports/audit-log';
import { uid } from '../../lib/util';
export class PostgresAuditLog implements AuditLog {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;
  constructor(connection: string | Pool, max = 2) {
    this.ownsPool = typeof connection === 'string';
    this.pool =
      typeof connection === 'string'
        ? new Pool({
            connectionString: connection,
            max,
            statement_timeout: 5_000,
            application_name: 'recruiting-os-audit',
          })
        : connection;
  }
  async write(event: AuditEvent): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id',$1,true)`, [event.tenantId]);
      await client.query(
        `insert into audit_events(id,tenant_id,actor_id,action,resource_type,resource_id,request_id,metadata) values($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          uid('aud'),
          event.tenantId,
          event.actorId ?? null,
          event.action,
          event.resourceType,
          event.resourceId ?? null,
          event.requestId ?? null,
          JSON.stringify(event.metadata ?? {}),
        ],
      );
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

import { Pool, type QueryResultRow } from 'pg';
import type { CancelPendingJobs, EnqueueJob, JobQueue } from '../../application/ports/job-queue';
import type { Job } from '../../domain/models';
import { stableId } from '../../lib/util';

export class PostgresJobQueue implements JobQueue {
  private readonly pool: Pool;
  constructor(connectionString: string, maxConnections = 5) {
    this.pool = new Pool({
      connectionString,
      max: maxConnections,
      statement_timeout: 5_000,
      application_name: 'recruiting-os-queue',
    });
  }
  async enqueue(input: EnqueueJob): Promise<Job> {
    const client = await this.pool.connect();
    const id = stableId('job', `${input.tenantId}:${input.type}:${input.idempotencyKey}`);
    try {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id',$1,true)`, [input.tenantId]);
      await client.query(
        `insert into jobs(id,tenant_id,type,idempotency_key,payload,status,priority,max_attempts,available_at)
        values($1,$2,$3,$4,$5,'queued',$6,$7,$8)
        on conflict(tenant_id,type,idempotency_key) do update set
          payload=excluded.payload,status='queued',priority=excluded.priority,
          attempt_count=0,max_attempts=excluded.max_attempts,available_at=excluded.available_at,
          leased_until=null,leased_by=null,last_error=null,updated_at=now()
        where jobs.status='cancelled'`,
        [
          id,
          input.tenantId,
          input.type,
          input.idempotencyKey,
          JSON.stringify(input.payload),
          input.priority ?? 100,
          input.maxAttempts ?? 5,
          input.availableAt ?? new Date().toISOString(),
        ],
      );
      const row = (await client.query('select * from jobs where id=$1', [id])).rows[0];
      await client.query('commit');
      return this.map(row);
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
  async cancelPending(input: CancelPendingJobs): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id',$1,true)`, [input.tenantId]);
      const result = await client.query(
        `update jobs set status='cancelled',leased_by=null,leased_until=null,
           last_error='Cancelled by connector revocation',updated_at=now()
         where tenant_id=$1 and type=$2 and status in ('queued','retryable_failed')
           and payload @> $3::jsonb`,
        [input.tenantId, input.type, JSON.stringify(input.payload)],
      );
      await client.query('commit');
      return result.rowCount ?? 0;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
  async leaseNext(workerId: string, leaseSeconds = 60): Promise<Job | undefined> {
    const row = (
      await this.pool.query('select * from app.lease_job($1,$2)', [workerId, leaseSeconds])
    ).rows[0];
    return row ? this.map(row) : undefined;
  }
  async complete(job: Job): Promise<void> {
    await this.pool.query('select app.finish_job($1,$2,null)', [job.id, job.leasedUntil]);
  }
  async fail(job: Job, error: unknown): Promise<void> {
    await this.pool.query('select app.finish_job($1,$2,$3)', [
      job.id,
      job.leasedUntil,
      (error instanceof Error ? error.message : String(error)).slice(0, 500),
    ]);
  }
  async stats(tenantId: string) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('app.tenant_id',$1,true)`, [tenantId]);
      const rows = (
        await client.query(
          `select status,count(*)::int as count from jobs where tenant_id=$1 group by status`,
          [tenantId],
        )
      ).rows;
      const oldest = (
        await client.query(
          `select extract(epoch from (now()-min(available_at)))::double precision as age
           from jobs where tenant_id=$1 and status in ('queued','retryable_failed')
           and available_at<=now()`,
          [tenantId],
        )
      ).rows[0];
      await client.query('commit');
      const counts = new Map(rows.map((row) => [row.status, Number(row.count)]));
      return {
        queued: counts.get('queued') ?? 0,
        running: counts.get('running') ?? 0,
        retryableFailed: counts.get('retryable_failed') ?? 0,
        deadLetter: counts.get('dead_letter') ?? 0,
        cancelled: counts.get('cancelled') ?? 0,
        oldestReadyAgeSeconds: Math.max(0, Number(oldest?.age ?? 0)),
      };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
  private map(row: QueryResultRow): Job {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      type: row.type,
      idempotencyKey: row.idempotency_key,
      payload: row.payload,
      status: row.status,
      attemptCount: row.attempt_count,
      maxAttempts: row.max_attempts,
      availableAt: row.available_at.toISOString(),
      leasedUntil: row.leased_until?.toISOString(),
    };
  }
}

import type { CancelPendingJobs, EnqueueJob, JobQueue } from '../../application/ports/job-queue';
import type { Job } from '../../domain/models';
import { nowIso, parseJsonSafe, stableId } from '../../lib/util';
import type { Store } from '../../store';

export class SqliteJobQueue implements JobQueue {
  constructor(private readonly store: Store) {}

  async enqueue(input: EnqueueJob): Promise<Job> {
    const id = stableId('job', `${input.tenantId}:${input.type}:${input.idempotencyKey}`);
    const now = nowIso();
    await this.store.transaction(async () => {
      this.store.ensureTenant(input.tenantId, input.tenantId);
      this.store.db
        .prepare(
          `insert into jobs(
        id,tenant_id,type,idempotency_key,payload,status,priority,max_attempts,available_at,created_at,updated_at
      ) values(?,?,?,?,?,'queued',?,?,?,?,?)
      on conflict(tenant_id,type,idempotency_key) do update set
        payload=excluded.payload,status='queued',priority=excluded.priority,
        attempt_count=0,max_attempts=excluded.max_attempts,available_at=excluded.available_at,
        leased_until=null,leased_by=null,last_error=null,updated_at=excluded.updated_at
      where jobs.status='cancelled'`,
        )
        .run(
          id,
          input.tenantId,
          input.type,
          input.idempotencyKey,
          JSON.stringify(input.payload),
          input.priority ?? 100,
          input.maxAttempts ?? 5,
          input.availableAt ?? now,
          now,
          now,
        );
    });
    const row = this.store.db.prepare('select * from jobs where id=?').get(id) as Record<
      string,
      unknown
    >;
    return this.map(row);
  }

  async cancelPending(input: CancelPendingJobs): Promise<number> {
    const candidates = this.store.db
      .prepare(
        `select id,payload from jobs where tenant_id=? and type=?
         and status in ('queued','retryable_failed')`,
      )
      .all(input.tenantId, input.type) as Array<{ id: string; payload: string }>;
    const ids = candidates
      .filter((candidate) => {
        const payload = parseJsonSafe<Record<string, unknown>>(candidate.payload, {});
        return Object.entries(input.payload).every(([key, value]) => payload[key] === value);
      })
      .map((candidate) => candidate.id);
    if (!ids.length) return 0;
    return this.store.transaction(async () => {
      const statement = this.store.db.prepare(
        `update jobs set status='cancelled',leased_by=null,leased_until=null,
         last_error='Cancelled by connector revocation',updated_at=? where id=?
         and status in ('queued','retryable_failed')`,
      );
      let cancelled = 0;
      for (const id of ids) cancelled += Number(statement.run(nowIso(), id).changes);
      return cancelled;
    });
  }

  async leaseNext(workerId: string, leaseSeconds = 60): Promise<Job | undefined> {
    return this.store.transaction(async () => {
      this.store.db
        .prepare(
          `update jobs set status='dead_letter',leased_by=null,leased_until=null,
           last_error='Worker lease expired after final attempt',updated_at=?
           where status='running' and leased_until<? and attempt_count>=max_attempts`,
        )
        .run(nowIso(), nowIso());
      const row = this.store.db
        .prepare(
          `with ranked as (
        select id,row_number() over(partition by tenant_id order by priority asc,created_at asc) as tenant_rank
        from jobs where
          (status in ('queued','retryable_failed') and available_at<=? and (leased_until is null or leased_until<?))
          or (status='running' and leased_until<? and attempt_count<max_attempts)
      ) select j.* from jobs j join ranked r on r.id=j.id
        left join tenant_queue_state t on t.tenant_id=j.tenant_id where r.tenant_rank=1
        order by coalesce(t.last_leased_at,'1970-01-01T00:00:00.000Z') asc,
        j.priority asc,j.created_at asc limit 1`,
        )
        .get(nowIso(), nowIso(), nowIso()) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      const leasedUntil = new Date(Date.now() + leaseSeconds * 1000).toISOString();
      this.store.db
        .prepare(
          `update jobs set status='running',attempt_count=attempt_count+1,
        leased_by=?,leased_until=?,updated_at=? where id=?`,
        )
        .run(workerId, leasedUntil, nowIso(), String(row.id));
      this.store.db
        .prepare(
          `insert into tenant_queue_state(tenant_id,last_leased_at) values(?,?)
        on conflict(tenant_id) do update set last_leased_at=excluded.last_leased_at`,
        )
        .run(String(row.tenant_id), nowIso());
      return this.map({
        ...row,
        status: 'running',
        attempt_count: Number(row.attempt_count) + 1,
        leased_until: leasedUntil,
        leased_by: workerId,
      });
    });
  }

  async renewLease(job: Job, leaseSeconds = 60): Promise<Job | undefined> {
    if (!job.leasedBy || !job.leasedUntil) return undefined;
    const renewedUntil = new Date(Date.now() + leaseSeconds * 1000).toISOString();
    const changed = this.store.db
      .prepare(
        `update jobs set leased_until=?,updated_at=? where id=? and status='running'
         and leased_by=? and leased_until=? and leased_until>?`,
      )
      .run(renewedUntil, nowIso(), job.id, job.leasedBy, job.leasedUntil, nowIso()).changes;
    return changed ? { ...job, leasedUntil: renewedUntil } : undefined;
  }

  async complete(job: Job): Promise<void> {
    if (!job.leasedBy || !job.leasedUntil) throw new Error('Job lease is missing');
    const changed = this.store.db
      .prepare(
        `update jobs set status='succeeded',leased_by=null,leased_until=null,last_error=null,updated_at=?
      where id=? and status='running' and leased_by=? and leased_until=? and leased_until>?`,
      )
      .run(nowIso(), job.id, job.leasedBy, job.leasedUntil, nowIso()).changes;
    if (!changed) throw new Error('Job lease is no longer valid');
  }

  async fail(job: Job, error: unknown): Promise<void> {
    if (!job.leasedBy || !job.leasedUntil) throw new Error('Job lease is missing');
    const terminal = job.attemptCount >= job.maxAttempts;
    const delay = Math.min(900, 2 ** Math.min(job.attemptCount, 9));
    const changed = this.store.db
      .prepare(
        `update jobs set status=?,available_at=?,leased_by=null,leased_until=null,last_error=?,updated_at=?
      where id=? and status='running' and leased_by=? and leased_until=? and leased_until>?`,
      )
      .run(
        terminal ? 'dead_letter' : 'retryable_failed',
        new Date(Date.now() + delay * 1000).toISOString(),
        (error instanceof Error ? error.message : String(error)).slice(0, 500),
        nowIso(),
        job.id,
        job.leasedBy,
        job.leasedUntil,
        nowIso(),
      ).changes;
    if (!changed) throw new Error('Job lease is no longer valid');
  }

  async stats(tenantId: string) {
    const rows = this.store.db
      .prepare('select status,count(*) as count from jobs where tenant_id=? group by status')
      .all(tenantId) as Array<{ status: string; count: number }>;
    const counts = new Map(rows.map((row) => [row.status, Number(row.count)]));
    const oldest = this.store.db
      .prepare(
        `select min(available_at) as available_at from jobs
         where tenant_id=? and status in ('queued','retryable_failed') and available_at<=?`,
      )
      .get(tenantId, nowIso()) as { available_at?: string } | undefined;
    return {
      queued: counts.get('queued') ?? 0,
      running: counts.get('running') ?? 0,
      retryableFailed: counts.get('retryable_failed') ?? 0,
      deadLetter: counts.get('dead_letter') ?? 0,
      cancelled: counts.get('cancelled') ?? 0,
      oldestReadyAgeSeconds: oldest?.available_at
        ? Math.max(0, (Date.now() - new Date(oldest.available_at).getTime()) / 1000)
        : 0,
    };
  }

  async close(): Promise<void> {}

  private map(row: Record<string, unknown>): Job {
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      type: String(row.type),
      idempotencyKey: String(row.idempotency_key),
      payload: parseJsonSafe(String(row.payload), {}),
      status: String(row.status) as Job['status'],
      attemptCount: Number(row.attempt_count),
      maxAttempts: Number(row.max_attempts),
      availableAt: String(row.available_at),
      leasedBy: row.leased_by ? String(row.leased_by) : undefined,
      leasedUntil: row.leased_until ? String(row.leased_until) : undefined,
    };
  }
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { SqliteJobQueue } from '../src/infrastructure/queue/sqlite-job-queue';
import { Store } from '../src/store';
import { ConnectorSyncScheduler } from '../src/application/connectors/connector-sync-scheduler';
import type { CredentialVault } from '../src/application/ports/credential-vault';
import type { JobQueue } from '../src/application/ports/job-queue';
import { JobLeaseHeartbeat } from '../src/application/queue/job-lease-heartbeat';

test('durable queue deduplicates, leases, retries, and dead-letters', async () => {
  const store = new Store();
  const queue = new SqliteJobQueue(store);
  const input = {
    tenantId: 'tenant_default',
    type: 'test',
    idempotencyKey: 'same',
    payload: { value: 1 },
    maxAttempts: 2,
  };
  const first = await queue.enqueue(input);
  const duplicate = await queue.enqueue(input);
  assert.equal(first.id, duplicate.id);
  const leased = await queue.leaseNext('worker', 30);
  assert.equal(leased?.attemptCount, 1);
  await queue.fail(leased!, new Error('temporary'));
  store.db
    .prepare('update jobs set available_at=? where id=?')
    .run(new Date(0).toISOString(), first.id);
  const retried = await queue.leaseNext('worker', 30);
  assert.equal(retried?.attemptCount, 2);
  await queue.fail(retried!, new Error('again'));
  const status = (
    store.db.prepare('select status from jobs where id=?').get(first.id) as { status: string }
  ).status;
  assert.equal(status, 'dead_letter');
  await store.close();
});

test('queue leases fairly across tenants', async () => {
  const store = new Store();
  const queue = new SqliteJobQueue(store);
  for (let index = 0; index < 3; index += 1)
    await queue.enqueue({ tenantId: 'a', type: 'test', idempotencyKey: `a-${index}`, payload: {} });
  await queue.enqueue({ tenantId: 'b', type: 'test', idempotencyKey: 'b', payload: {} });
  const first = await queue.leaseNext('worker');
  assert.ok(first);
  await queue.complete(first!);
  const second = await queue.leaseNext('worker');
  assert.ok(second);
  assert.notEqual(first?.tenantId, second?.tenantId);
  await store.close();
});

test('expired running jobs are recovered and stale workers cannot settle them', async () => {
  const store = new Store();
  const queue = new SqliteJobQueue(store);
  await queue.enqueue({
    tenantId: 'tenant_default',
    type: 'test',
    idempotencyKey: 'recover-expired',
    payload: {},
    maxAttempts: 2,
  });
  const stale = await queue.leaseNext('worker-a', 30);
  assert.equal(stale?.leasedBy, 'worker-a');
  store.db
    .prepare('update jobs set leased_until=? where id=?')
    .run(new Date(0).toISOString(), stale!.id);

  const recovered = await queue.leaseNext('worker-b', 30);
  assert.equal(recovered?.id, stale?.id);
  assert.equal(recovered?.leasedBy, 'worker-b');
  assert.equal(recovered?.attemptCount, 2);
  await assert.rejects(queue.complete(stale!), /lease is no longer valid/);

  const renewed = await queue.renewLease(recovered!, 60);
  assert.ok(renewed);
  assert.notEqual(renewed?.leasedUntil, recovered?.leasedUntil);
  await queue.complete(renewed!);
  assert.equal(
    (store.db.prepare('select status from jobs where id=?').get(stale!.id) as { status: string })
      .status,
    'succeeded',
  );
  await store.close();
});

test('a crashed final attempt is dead-lettered instead of leased forever', async () => {
  const store = new Store();
  const queue = new SqliteJobQueue(store);
  const queued = await queue.enqueue({
    tenantId: 'tenant_default',
    type: 'test',
    idempotencyKey: 'final-expired',
    payload: {},
    maxAttempts: 1,
  });
  await queue.leaseNext('worker-a', 30);
  store.db
    .prepare('update jobs set leased_until=? where id=?')
    .run(new Date(0).toISOString(), queued.id);

  assert.equal(await queue.leaseNext('worker-b', 30), undefined);
  const row = store.db.prepare('select status,last_error from jobs where id=?').get(queued.id) as {
    status: string;
    last_error: string;
  };
  assert.equal(row.status, 'dead_letter');
  assert.match(row.last_error, /lease expired/i);
  await store.close();
});

test('long-running work renews its lease through the heartbeat', async () => {
  let renewals = 0;
  const queue = {
    renewLease: async (job) => {
      renewals += 1;
      return { ...job, leasedUntil: new Date(Date.now() + 60_000).toISOString() };
    },
  } as JobQueue;
  const heartbeat = new JobLeaseHeartbeat(
    queue,
    {
      id: 'job',
      tenantId: 'tenant',
      type: 'test',
      idempotencyKey: 'heartbeat',
      payload: {},
      status: 'running',
      attemptCount: 1,
      maxAttempts: 3,
      availableAt: new Date().toISOString(),
      leasedBy: 'worker',
      leasedUntil: new Date(Date.now() + 60_000).toISOString(),
    },
    60,
    5,
  );
  heartbeat.start();
  await new Promise((resolve) => setTimeout(resolve, 25));
  const owned = await heartbeat.stop();
  assert.ok(owned);
  assert.ok(renewals >= 1);
});

test('connector revocation cancels only matching pending sync jobs', async () => {
  const store = new Store();
  const queue = new SqliteJobQueue(store);
  const gmail = await queue.enqueue({
    tenantId: 'tenant_default',
    type: 'connector.sync',
    idempotencyKey: 'gmail',
    payload: { provider: 'gmail', userId: 'user-a', organizationId: 'club-a' },
  });
  const linkedin = await queue.enqueue({
    tenantId: 'tenant_default',
    type: 'connector.sync',
    idempotencyKey: 'linkedin',
    payload: { provider: 'linkedin', userId: 'user-a', organizationId: 'club-a' },
  });
  await queue.enqueue({
    tenantId: 'other-tenant',
    type: 'connector.sync',
    idempotencyKey: 'gmail',
    payload: { provider: 'gmail', userId: 'user-a', organizationId: 'club-a' },
  });

  const cancelled = await queue.cancelPending({
    tenantId: 'tenant_default',
    type: 'connector.sync',
    payload: { provider: 'gmail', userId: 'user-a' },
  });

  assert.equal(cancelled, 1);
  const statuses = store.db.prepare('select id,status from jobs order by id').all() as Array<{
    id: string;
    status: string;
  }>;
  assert.equal(statuses.find((job) => job.id === gmail.id)?.status, 'cancelled');
  assert.equal(statuses.find((job) => job.id === linkedin.id)?.status, 'queued');
  assert.equal((await queue.stats('tenant_default')).cancelled, 1);

  const reconnected = await queue.enqueue({
    tenantId: 'tenant_default',
    type: 'connector.sync',
    idempotencyKey: 'gmail',
    payload: { provider: 'gmail', userId: 'user-a', organizationId: 'club-a' },
  });
  assert.equal(reconnected.id, gmail.id);
  assert.equal(reconnected.status, 'queued');
  assert.equal((await queue.stats('tenant_default')).cancelled, 0);
  await store.close();
});

test('a sync finishing after revocation cannot recreate its recurring schedule', async () => {
  const store = new Store();
  const queue = new SqliteJobQueue(store);
  const vault = new ToggleCredentialVault();
  const scheduler = new ConnectorSyncScheduler(queue, vault, 900, () => 1_800_000);
  const job = await queue.enqueue({
    tenantId: 'tenant_default',
    type: 'connector.sync',
    idempotencyKey: 'running-sync',
    payload: { provider: 'gmail', userId: 'user-a', organizationId: 'club-a' },
  });
  await vault.revoke('tenant_default', 'user-a', 'gmail');

  const scheduled = await scheduler.scheduleAfter(job, {
    provider: 'gmail',
    userId: 'user-a',
    organizationId: 'club-a',
    recurring: true,
  });

  assert.equal(scheduled, undefined);
  assert.equal(
    (
      store.db.prepare('select count(*) as count from jobs where id<>?').get(job.id) as {
        count: number;
      }
    ).count,
    0,
  );
  await store.close();
});

class ToggleCredentialVault implements CredentialVault {
  private connected = true;
  async put(_tenantId: string, _userId: string, _provider: string) {
    this.connected = true;
  }
  async get(_tenantId: string, _userId: string, _provider: string) {
    return this.connected ? { accessToken: 'token', scopes: [] } : undefined;
  }
  async revoke(_tenantId: string, _userId: string, _provider: string) {
    this.connected = false;
  }
}

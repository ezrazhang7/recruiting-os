import assert from 'node:assert/strict';
import test from 'node:test';
import { SqliteJobQueue } from '../src/infrastructure/queue/sqlite-job-queue';
import { Store } from '../src/store';
import { ConnectorSyncScheduler } from '../src/application/connectors/connector-sync-scheduler';
import type { CredentialVault } from '../src/application/ports/credential-vault';

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

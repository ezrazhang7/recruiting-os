import assert from 'node:assert/strict';
import test from 'node:test';
import { SqliteJobQueue } from '../src/infrastructure/queue/sqlite-job-queue';
import { Store } from '../src/store';

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

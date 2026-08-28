import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { migrate } from '../src/infrastructure/database/postgres/migrate';
import { PostgresStore } from '../src/infrastructure/database/postgres/postgres-store';
import { PostgresRateLimiter } from '../src/infrastructure/rate-limit/postgres-rate-limiter';
import { PostgresJobQueue } from '../src/infrastructure/queue/postgres-job-queue';
import { runMaintenance } from '../src/infrastructure/database/postgres/maintenance';

const adminUrl = process.env.TEST_DATABASE_URL;

test(
  'Postgres migrations execute and RLS fails closed across tenants',
  { skip: !adminUrl },
  async () => {
    if (!adminUrl) return;
    await migrate(adminUrl);
    const admin = new Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`do $$ begin
    if not exists(select 1 from pg_roles where rolname='recruiting_os_test') then
      create role recruiting_os_test login password 'test-only-password' nosuperuser nocreatedb nocreaterole;
    end if;
  end $$`);
    await admin.query('grant connect on database recruiting_os to recruiting_os_test');
    await admin.query('grant usage on schema public,app to recruiting_os_test');
    await admin.query(
      'grant select,insert,update,delete on all tables in schema public to recruiting_os_test',
    );
    await admin.query('grant usage,select on all sequences in schema public to recruiting_os_test');
    await admin.query('grant execute on all functions in schema app to recruiting_os_test');

    const url = new URL(adminUrl);
    url.username = 'recruiting_os_test';
    url.password = 'test-only-password';
    const store = new PostgresStore({
      connectionString: url.toString(),
      defaultTenantId: 'tenant-a',
    });
    try {
      await store.upsertOrganization(
        { id: 'shared', name: 'Tenant A Club', school: 'UNC' },
        'tenant-a',
      );
      await store.upsertOrganization(
        { id: 'shared', name: 'Tenant B Club', school: 'UNC' },
        'tenant-b',
      );
      assert.equal((await store.getOrganization('shared', 'tenant-a'))?.name, 'Tenant A Club');
      assert.equal((await store.getOrganization('shared', 'tenant-b'))?.name, 'Tenant B Club');

      const appPool = new Pool({ connectionString: url.toString(), max: 1 });
      const client = await appPool.connect();
      try {
        await client.query('begin');
        await client.query("select set_config('app.tenant_id','tenant-a',true)");
        const rows = await client.query('select id from organizations where tenant_id=$1', [
          'tenant-b',
        ]);
        assert.equal(rows.rowCount, 0);
        await assert.rejects(
          client.query(
            "insert into organizations(tenant_id,id,name,school) values('tenant-b','blocked','Blocked','UNC')",
          ),
          /row-level security policy/,
        );
        await client.query('rollback');
      } finally {
        client.release();
        await appPool.end();
      }

      const queue = new PostgresJobQueue(url.toString(), 1);
      let cancelledJobId = '';
      try {
        const queued = await queue.enqueue({
          tenantId: 'tenant-a',
          type: 'connector.sync',
          idempotencyKey: `cancel-${crypto.randomUUID()}`,
          payload: { provider: 'gmail', userId: 'user-a', organizationId: 'shared' },
        });
        cancelledJobId = queued.id;
        assert.equal(
          await queue.cancelPending({
            tenantId: 'tenant-a',
            type: 'connector.sync',
            payload: { provider: 'gmail', userId: 'user-a' },
          }),
          1,
        );
        assert.ok((await queue.stats('tenant-a')).cancelled >= 1);
      } finally {
        await queue.close();
      }

      const privateSource = await store.stageSource(
        {
          id: `gmail-${crypto.randomUUID()}`,
          tenantId: 'tenant-a',
          organizationId: 'shared',
          sourceType: 'gmail',
          externalId: `message-${crypto.randomUUID()}`,
          rawText: 'private recruiting message',
          media: [{ type: 'image', base64: 'private-image' }],
          fetchedAt: new Date(Date.now() - 91 * 86_400_000).toISOString(),
          metadata: { privateHeader: 'secret' },
        },
        'tenant-a',
      );
      await admin.query("update jobs set updated_at=now()-interval '31 days' where id=$1", [
        cancelledJobId,
      ]);

      const maintenance = await runMaintenance(url.toString());
      assert.ok(maintenance.privateSourceVersions >= 1);
      assert.ok(maintenance.failedJobPayloads >= 1);
      const redactedSource = (
        await admin.query<{
          raw_text: string;
          media: unknown;
          metadata: { retentionRedacted?: boolean };
        }>('select raw_text,media,metadata from source_versions where id=$1', [
          privateSource.versionId,
        ])
      ).rows[0];
      assert.equal(redactedSource?.raw_text, '');
      assert.deepEqual(redactedSource?.media, []);
      assert.equal(redactedSource?.metadata.retentionRedacted, true);
      const redactedJob = (
        await admin.query<{ payload: { retentionRedacted?: boolean } }>(
          'select payload from jobs where id=$1',
          [cancelledJobId],
        )
      ).rows[0];
      assert.equal(redactedJob?.payload.retentionRedacted, true);
    } finally {
      await store.close();
      await admin.end();
    }
  },
);

test('Postgres rate limiting is shared and atomic', { skip: !adminUrl }, async () => {
  if (!adminUrl) return;
  await migrate(adminUrl);
  const limiter = new PostgresRateLimiter(adminUrl, 4);
  try {
    const key = `integration:${crypto.randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => limiter.consume(key, 5, 60_000)),
    );
    assert.equal(results.filter((result) => result.allowed).length, 5);
    assert.equal(results.filter((result) => !result.allowed).length, 3);
  } finally {
    await limiter.close();
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { migrate } from '../src/infrastructure/database/postgres/migrate';
import { PostgresStore } from '../src/infrastructure/database/postgres/postgres-store';
import { PostgresRateLimiter } from '../src/infrastructure/rate-limit/postgres-rate-limiter';

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

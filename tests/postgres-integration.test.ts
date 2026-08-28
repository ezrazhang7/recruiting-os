import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { migrate } from '../src/infrastructure/database/postgres/migrate';
import { PostgresStore } from '../src/infrastructure/database/postgres/postgres-store';
import { PostgresRateLimiter } from '../src/infrastructure/rate-limit/postgres-rate-limiter';
import { PostgresJobQueue } from '../src/infrastructure/queue/postgres-job-queue';
import { runMaintenance } from '../src/infrastructure/database/postgres/maintenance';
import { loadConfig } from '../src/config/env';
import { createDependencies } from '../src/bootstrap/dependencies';

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

        const recoverable = await queue.enqueue({
          tenantId: 'tenant-a',
          type: 'test',
          idempotencyKey: `recover-${crypto.randomUUID()}`,
          payload: {},
          maxAttempts: 2,
        });
        const staleLease = await queue.leaseNext('worker-a', 30);
        assert.equal(staleLease?.id, recoverable.id);
        await admin.query("update jobs set leased_until=now()-interval '1 second' where id=$1", [
          recoverable.id,
        ]);
        const recoveredLease = await queue.leaseNext('worker-b', 30);
        assert.equal(recoveredLease?.id, recoverable.id);
        assert.equal(recoveredLease?.leasedBy, 'worker-b');
        assert.equal(recoveredLease?.attemptCount, 2);
        await assert.rejects(queue.complete(staleLease!), /lease is no longer valid/);
        const renewedLease = await queue.renewLease(recoveredLease!, 60);
        assert.ok(renewedLease);
        await queue.complete(renewedLease!);
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

test('Postgres adapters share one bounded pool per process', { skip: !adminUrl }, async () => {
  if (!adminUrl) return;
  await migrate(adminUrl);
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_DRIVER: 'postgres',
    DATABASE_URL: adminUrl,
    DATABASE_POOL_SIZE: '3',
  });
  const dependencies = createDependencies(config, 'api');
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  const suffix = crypto.randomUUID();
  try {
    await dependencies.repository.upsertOrganization(
      { id: `pool-org-${suffix}`, name: 'Pool Test', school: 'UNC' },
      'unc',
    );
    const userId = await dependencies.authRepository.upsertIdentity(
      { issuer: 'https://test.example', subject: `pool-user-${suffix}` },
      'unc',
    );
    await Promise.all([
      dependencies.queue.stats('unc'),
      dependencies.auditLog.write({
        tenantId: 'unc',
        actorId: userId,
        action: 'pool.test',
        resourceType: 'test',
      }),
      dependencies.credentialVault.put('unc', userId, 'gmail', {
        accessToken: 'test-only-token',
        scopes: ['readonly'],
      }),
      ...Array.from({ length: 12 }, (_, index) =>
        dependencies.rateLimiter.consume(`pool:${suffix}:${index}`, 1, 60_000),
      ),
    ]);

    const pools = await admin.query<{ application_name: string; connections: string }>(
      `select application_name,count(*)::text as connections
       from pg_stat_activity
       where datname=current_database() and application_name like 'recruiting-os-%'
       group by application_name`,
    );
    assert.deepEqual(
      pools.rows.map((row) => row.application_name),
      ['recruiting-os-api'],
    );
    assert.ok(Number(pools.rows[0]?.connections) >= 1);
    assert.ok(Number(pools.rows[0]?.connections) <= 3);
  } finally {
    await dependencies.close();
    await admin.end();
  }
});

test(
  'Postgres account erasure is tenant-scoped and preserves shared private evidence',
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
    const appUrl = new URL(adminUrl);
    appUrl.username = 'recruiting_os_test';
    appUrl.password = 'test-only-password';
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_DRIVER: 'postgres',
      DATABASE_URL: appUrl.toString(),
      DATABASE_POOL_SIZE: '3',
      DEFAULT_TENANT_ID: 'privacy-tenant',
    });
    const dependencies = createDependencies(config, 'api');
    const suffix = crypto.randomUUID();
    try {
      await dependencies.repository.upsertOrganization(
        { id: 'privacy-org', name: 'Privacy Org', school: 'UNC' },
        'privacy-tenant',
      );
      const firstIdentity = { issuer: 'https://privacy.example', subject: `first-${suffix}` };
      const firstUser = await dependencies.authRepository.upsertIdentity(
        firstIdentity,
        'privacy-tenant',
      );
      assert.equal(
        await dependencies.authRepository.upsertIdentity(firstIdentity, 'other-privacy-tenant'),
        firstUser,
      );
      const secondUser = await dependencies.authRepository.upsertIdentity(
        { issuer: 'https://privacy.example', subject: `second-${suffix}` },
        'privacy-tenant',
      );
      const sharedSource = {
        id: `shared-${suffix}`,
        tenantId: 'privacy-tenant',
        organizationId: 'privacy-org',
        sourceType: 'gmail' as const,
        externalId: `shared-${suffix}`,
        rawText: 'shared private evidence',
        media: [],
        fetchedAt: new Date().toISOString(),
      };
      const sharedVersion = await dependencies.repository.stageSource({
        ...sharedSource,
        contributorUserId: firstUser,
      });
      await dependencies.repository.stageSource({
        ...sharedSource,
        contributorUserId: secondUser,
      });
      const soleVersion = await dependencies.repository.stageSource({
        ...sharedSource,
        id: `sole-${suffix}`,
        externalId: `sole-${suffix}`,
        rawText: 'sole private evidence',
        contributorUserId: firstUser,
      });
      await dependencies.credentialVault.put('privacy-tenant', firstUser, 'gmail', {
        accessToken: 'postgres-private-token',
        scopes: ['gmail.readonly'],
      });
      await dependencies.queue.enqueue({
        tenantId: 'privacy-tenant',
        type: 'connector.sync',
        idempotencyKey: `privacy-${suffix}`,
        payload: { userId: firstUser, provider: 'gmail', organizationId: 'privacy-org' },
      });
      await dependencies.repository.setConnectorState(
        'gmail',
        firstUser,
        'cursor',
        {},
        'privacy-tenant',
        firstUser,
      );

      const exported = await dependencies.privacyRepository.exportAccount(
        'privacy-tenant',
        firstUser,
      );
      assert.equal(exported?.contributions.length, 2);
      assert.equal(exported?.contributions.filter((item) => item.shared).length, 1);
      assert.equal(exported?.connectors[0]?.provider, 'gmail');
      assert.doesNotMatch(JSON.stringify(exported), /postgres-private-token/);

      const erased = await dependencies.privacyRepository.eraseAccount(
        'privacy-tenant',
        firstUser,
        suffix,
      );
      assert.equal(erased.membershipDeleted, true);
      assert.equal(erased.identityDeleted, false);
      assert.equal(erased.privateSourceVersionsDeleted, 1);
      assert.equal(erased.contributionsRemoved, 2);
      assert.deepEqual(erased.affectedOrganizationIds, ['privacy-org']);
      assert.equal(erased.reconciliationJobIds.length, 1);
      assert.ok((await dependencies.queue.stats('privacy-tenant')).queued >= 1);
      assert.ok(await dependencies.repository.getSource(sharedVersion.versionId, 'privacy-tenant'));
      assert.equal(
        await dependencies.repository.getSource(soleVersion.versionId, 'privacy-tenant'),
        undefined,
      );
      assert.equal(
        await dependencies.credentialVault.get('privacy-tenant', firstUser, 'gmail'),
        undefined,
      );
      assert.deepEqual(
        await dependencies.repository.getConnectorState('gmail', firstUser, 'privacy-tenant'),
        { metadata: {} },
      );
      assert.equal(
        (
          await admin.query(
            `select count(*)::int as count from source_version_contributors
           where tenant_id='privacy-tenant' and user_id=$1`,
            [secondUser],
          )
        ).rows[0]?.count,
        1,
      );
      assert.equal(
        (
          await admin.query(
            `select count(*)::int as count from memberships
             where tenant_id='other-privacy-tenant' and user_id=$1`,
            [firstUser],
          )
        ).rows[0]?.count,
        1,
      );
      assert.equal(
        (await admin.query('select membership_count from users where id=$1', [firstUser])).rows[0]
          ?.membership_count,
        1,
      );
    } finally {
      await dependencies.close();
      await admin.end();
    }
  },
);

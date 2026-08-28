import { Pool } from 'pg';

const roleNamePattern = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

export async function grantPostgresRuntimeRole(
  migrationDatabaseUrl: string,
  runtimeRole: string,
): Promise<void> {
  if (!roleNamePattern.test(runtimeRole)) throw new Error('RUNTIME_DATABASE_ROLE is invalid');
  const pool = new Pool({
    connectionString: migrationDatabaseUrl,
    max: 1,
    statement_timeout: 60_000,
    application_name: 'recruiting-os-runtime-grants',
  });
  const client = await pool.connect();
  const quotedRole = `"${runtimeRole}"`;
  try {
    const target = (
      await client.query<{
        rolsuper: boolean;
        rolbypassrls: boolean;
        inherits_owner: boolean;
        owns_database_or_schema: boolean;
      }>(
        `select target.rolsuper,target.rolbypassrls,
          exists (
            select 1 from pg_class tables
            join pg_namespace namespaces on namespaces.oid=tables.relnamespace
            where namespaces.nspname='public'
              and tables.relname in (
                'memberships','organizations','sources','source_versions',
                'source_version_contributors','claims','opportunities','opportunity_overrides',
                'connector_state','credentials','sessions','jobs','tenant_queue_state','audit_events'
              )
              and pg_has_role($1::name,tables.relowner,'MEMBER')
          ) as inherits_owner,
          exists(select 1 from pg_database where datname=current_database() and datdba=target.oid)
            or exists(
              select 1 from pg_namespace
              where nspname in ('public','app') and nspowner=target.oid
            ) as owns_database_or_schema
        from pg_roles target where target.rolname=$1`,
        [runtimeRole],
      )
    ).rows[0];
    if (!target) throw new Error(`Runtime database role "${runtimeRole}" does not exist`);
    if (
      target.rolsuper ||
      target.rolbypassrls ||
      target.inherits_owner ||
      target.owns_database_or_schema
    ) {
      throw new Error('Runtime database role must be NOSUPERUSER NOBYPASSRLS and a non-owner');
    }

    const databaseName = (await client.query<{ name: string }>('select current_database() as name'))
      .rows[0]?.name;
    if (!databaseName) throw new Error('Could not determine the current database');
    const quotedDatabase = `"${databaseName.replaceAll('"', '""')}"`;
    await client.query('begin');
    await client.query('revoke create on schema public from public');
    await client.query('revoke usage,create on schema app from public');
    await client.query('revoke execute on all functions in schema app from public');
    await client.query(`revoke create on schema public,app from ${quotedRole}`);
    await client.query(`grant connect on database ${quotedDatabase} to ${quotedRole}`);
    await client.query(`grant usage on schema public,app to ${quotedRole}`);
    await client.query(
      `grant select,insert,update,delete on all tables in schema public to ${quotedRole}`,
    );
    await client.query(`grant usage,select on all sequences in schema public to ${quotedRole}`);
    await client.query(`grant execute on all functions in schema app to ${quotedRole}`);
    await client.query(
      `alter default privileges in schema public
       grant select,insert,update,delete on tables to ${quotedRole}`,
    );
    await client.query(
      `alter default privileges in schema public grant usage,select on sequences to ${quotedRole}`,
    );
    await client.query(
      'alter default privileges in schema app revoke execute on functions from public',
    );
    await client.query(
      `alter default privileges in schema app grant execute on functions to ${quotedRole}`,
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  const migrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL;
  const runtimeRole = process.env.RUNTIME_DATABASE_ROLE;
  if (!migrationDatabaseUrl || !runtimeRole) {
    throw new Error('MIGRATION_DATABASE_URL and RUNTIME_DATABASE_ROLE are required');
  }
  grantPostgresRuntimeRole(migrationDatabaseUrl, runtimeRole).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

import type { Pool } from 'pg';

interface RuntimeRoleRow {
  role_name: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  inherits_protected_owner: boolean;
  can_create_schema: boolean;
}

export async function assertSafePostgresRuntimeRole(pool: Pool): Promise<void> {
  const row = (
    await pool.query<RuntimeRoleRow>(`
      select current_user as role_name, roles.rolsuper, roles.rolbypassrls,
        exists (
          select 1 from pg_class tables
          join pg_namespace namespaces on namespaces.oid=tables.relnamespace
          where namespaces.nspname='public'
            and tables.relname in (
              'memberships','organizations','sources','source_versions',
              'source_version_contributors','claims','opportunities','opportunity_overrides',
              'connector_state','credentials','sessions','jobs','tenant_queue_state','audit_events'
            )
            and pg_has_role(current_user,tables.relowner,'MEMBER')
        ) as inherits_protected_owner,
        has_schema_privilege(current_user,'public','CREATE')
          or has_schema_privilege(current_user,'app','CREATE') as can_create_schema
      from pg_roles roles where roles.rolname=current_user
    `)
  ).rows[0];
  if (!row) throw new Error('Could not inspect the Postgres runtime role');
  if (row.rolsuper || row.rolbypassrls || row.inherits_protected_owner || row.can_create_schema) {
    throw new Error(
      `Unsafe Postgres runtime role "${row.role_name}": production requires a dedicated ` +
        'NOSUPERUSER NOBYPASSRLS role that cannot create schema objects or own/inherit tenant tables',
    );
  }
}

export async function assertPlatformAdminBootstrap(
  pool: Pool,
  tenantId: string,
  initialPlatformAdminEmails: readonly string[],
): Promise<void> {
  if (initialPlatformAdminEmails.length) return;
  const client = await pool.connect();
  let hasAdmin = false;
  try {
    await client.query('begin');
    await client.query(`select set_config('app.tenant_id',$1,true)`, [tenantId]);
    const result = await client.query<{ present: boolean }>(
      `select exists(
          select 1 from memberships
          where tenant_id=$1 and 'platform_admin'=any(roles)
        ) as present`,
      [tenantId],
    );
    hasAdmin = Boolean(result.rows[0]?.present);
  } finally {
    await client.query('rollback');
    client.release();
  }
  if (!hasAdmin) {
    throw new Error(
      'Production requires INITIAL_PLATFORM_ADMIN_EMAILS until the first platform admin exists',
    );
  }
}

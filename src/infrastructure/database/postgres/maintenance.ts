import { Pool } from 'pg';

export interface MaintenanceResult {
  privateSourceVersions: number;
  privateClaimEvidence: number;
  failedJobPayloads: number;
  expiredSessions: number;
  revokedCredentials: number;
  expiredAuditEvents: number;
  expiredRateBuckets: number;
}

export async function runMaintenance(databaseUrl: string): Promise<MaintenanceResult> {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    statement_timeout: 60_000,
    application_name: 'recruiting-os-maintenance',
  });
  try {
    const result = await pool.query<{ result: MaintenanceResult }>(
      'select app.run_maintenance() as result',
    );
    const value = result.rows[0]?.result;
    if (!value) throw new Error('Maintenance did not return a result');
    return value;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  runMaintenance(databaseUrl)
    .then((result) => console.log(JSON.stringify({ maintenance: result })))
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}

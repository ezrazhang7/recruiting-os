import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';

export async function migrate(databaseUrl: string, directory = resolve('migrations')): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query(`create table if not exists schema_migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    )`);
    const applied = new Set(
      (await client.query<{ version: string }>('select version from schema_migrations')).rows.map(
        (row) => row.version,
      ),
    );
    const files = (await readdir(directory))
      .filter((file) => /^\d+.*\.sql$/.test(file) && !file.endsWith('.down.sql'))
      .sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      await client.query(await readFile(resolve(directory, file), 'utf8'));
      await client.query('insert into schema_migrations(version) values($1)', [file]);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  migrate(databaseUrl).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

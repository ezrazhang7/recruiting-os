import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import type { RateLimiter, RateLimitResult } from '../../application/ports/rate-limiter';

export class PostgresRateLimiter implements RateLimiter {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;

  constructor(connection: string | Pool, maxConnections = 3) {
    this.ownsPool = typeof connection === 'string';
    this.pool =
      typeof connection === 'string'
        ? new Pool({
            connectionString: connection,
            max: maxConnections,
            statement_timeout: 2_000,
            application_name: 'recruiting-os-rate-limit',
          })
        : connection;
  }

  async consume(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const hash = createHash('sha256').update(key).digest('hex');
    const row = (
      await this.pool.query<{
        allowed: boolean;
        remaining: number;
        reset_at_ms: string;
      }>('select * from app.consume_rate_limit($1,$2,$3)', [hash, limit, windowMs])
    ).rows[0];
    if (!row) throw new Error('Rate limiter returned no result');
    return {
      allowed: row.allowed,
      remaining: row.remaining,
      resetAt: Number(row.reset_at_ms),
    };
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }
}

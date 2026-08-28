import type { AuthRepository } from '../application/ports/auth-repository';
import type { JobQueue } from '../application/ports/job-queue';
import type { RecruitingRepository } from '../application/ports/recruiting-repository';
import type { CredentialVault } from '../application/ports/credential-vault';
import type { AuditLog } from '../application/ports/audit-log';
import type { AppConfig } from '../config/env';
import { PostgresAuthRepository } from '../infrastructure/auth/postgres-auth-repository';
import { SqliteAuthRepository } from '../infrastructure/auth/sqlite-auth-repository';
import { PostgresStore } from '../infrastructure/database/postgres/postgres-store';
import { PostgresJobQueue } from '../infrastructure/queue/postgres-job-queue';
import { SqliteJobQueue } from '../infrastructure/queue/sqlite-job-queue';
import { Store } from '../store';
import { EncryptedCredentialVault } from '../infrastructure/credentials/encrypted-credential-vault';
import { PostgresCredentialRepository } from '../infrastructure/credentials/postgres-credential-repository';
import { SqliteCredentialRepository } from '../infrastructure/credentials/sqlite-credential-repository';
import { PostgresAuditLog } from '../infrastructure/observability/postgres-audit-log';
import { SqliteAuditLog } from '../infrastructure/observability/sqlite-audit-log';
import { Pool, type PoolConfig } from 'pg';
import type { RateLimiter } from '../application/ports/rate-limiter';
import { PostgresRateLimiter } from '../infrastructure/rate-limit/postgres-rate-limiter';
import { InMemoryRateLimiter } from '../infrastructure/rate-limit/in-memory-rate-limiter';
import type { PrivacyRepository } from '../application/ports/privacy-repository';
import { PostgresPrivacyRepository } from '../infrastructure/privacy/postgres-privacy-repository';
import { SqlitePrivacyRepository } from '../infrastructure/privacy/sqlite-privacy-repository';
import {
  assertPlatformAdminBootstrap,
  assertSafePostgresRuntimeRole,
} from '../infrastructure/database/postgres/runtime-role';

export interface RuntimeDependencies {
  repository: RecruitingRepository;
  authRepository: AuthRepository;
  queue: JobQueue;
  credentialVault: CredentialVault;
  auditLog: AuditLog;
  rateLimiter: RateLimiter;
  privacyRepository: PrivacyRepository;
  validateRuntime(): Promise<void>;
  close(): Promise<void>;
}

export function postgresPoolOptions(config: AppConfig, component: 'api' | 'worker'): PoolConfig {
  if (!config.database.url) throw new Error('DATABASE_URL is required for Postgres');
  return {
    connectionString: config.database.url,
    max: config.database.poolSize,
    statement_timeout: 5_000,
    idle_in_transaction_session_timeout: 10_000,
    connectionTimeoutMillis: 5_000,
    application_name: `recruiting-os-${component}`,
  };
}

export function createDependencies(
  config: AppConfig,
  component: 'api' | 'worker' = 'api',
): RuntimeDependencies {
  if (config.database.driver === 'postgres') {
    const databaseUrl = config.database.url;
    if (!databaseUrl) throw new Error('DATABASE_URL is required for Postgres');
    const pool = new Pool(postgresPoolOptions(config, component));
    const repository = new PostgresStore({
      connectionString: databaseUrl,
      pool,
      defaultTenantId: config.defaultTenantId,
    });
    const authRepository = new PostgresAuthRepository(pool);
    const queue = new PostgresJobQueue(pool);
    const credentialRepository = new PostgresCredentialRepository(pool);
    const credentialVault = new EncryptedCredentialVault(
      credentialRepository,
      config.auth.credentialMasterKey,
      config.auth.credentialKeyVersion,
    );
    const auditLog = new PostgresAuditLog(pool);
    const rateLimiter = new PostgresRateLimiter(pool);
    const privacyRepository = new PostgresPrivacyRepository(pool);
    return {
      repository,
      authRepository,
      queue,
      credentialVault,
      auditLog,
      rateLimiter,
      privacyRepository,
      validateRuntime: async () => {
        if (config.environment === 'production') {
          await assertSafePostgresRuntimeRole(pool);
          await assertPlatformAdminBootstrap(
            pool,
            config.defaultTenantId,
            config.auth.initialPlatformAdminEmails,
          );
        }
      },
      close: async () => {
        await Promise.all([
          repository.close(),
          authRepository.close(),
          queue.close(),
          credentialRepository.close(),
          auditLog.close(),
          rateLimiter.close(),
          privacyRepository.close(),
        ]);
        await pool.end();
      },
    };
  }
  if (config.environment === 'production') throw new Error('SQLite cannot be used in production');
  const repository = new Store(config.database.path, config.defaultTenantId);
  const authRepository = new SqliteAuthRepository(repository);
  const queue = new SqliteJobQueue(repository);
  const credentialRepository = new SqliteCredentialRepository(repository);
  const credentialVault = new EncryptedCredentialVault(
    credentialRepository,
    config.auth.credentialMasterKey,
    config.auth.credentialKeyVersion,
  );
  const auditLog = new SqliteAuditLog(repository);
  const privacyRepository = new SqlitePrivacyRepository(repository);
  return {
    repository,
    authRepository,
    queue,
    credentialVault,
    auditLog,
    rateLimiter: new InMemoryRateLimiter(),
    privacyRepository,
    validateRuntime: async () => {},
    close: async () => {
      await Promise.all([
        authRepository.close(),
        queue.close(),
        credentialRepository.close(),
        auditLog.close(),
        privacyRepository.close(),
      ]);
      await repository.close();
    },
  };
}

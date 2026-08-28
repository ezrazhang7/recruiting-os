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

export interface RuntimeDependencies {repository:RecruitingRepository;authRepository:AuthRepository;queue:JobQueue;credentialVault:CredentialVault;auditLog:AuditLog;close():Promise<void>;}
export function createDependencies(config:AppConfig):RuntimeDependencies{
  if(config.database.driver==='postgres'){
    if(!config.database.url)throw new Error('DATABASE_URL is required for Postgres');
    const repository=new PostgresStore({connectionString:config.database.url,maxConnections:config.database.poolSize,defaultTenantId:config.defaultTenantId});
    const authRepository=new PostgresAuthRepository(config.database.url,Math.max(2,Math.floor(config.database.poolSize/2)));
    const queue=new PostgresJobQueue(config.database.url,Math.max(2,Math.floor(config.database.poolSize/2)));
    const credentialRepository=new PostgresCredentialRepository(config.database.url,Math.max(2,Math.floor(config.database.poolSize/3)));const credentialVault=new EncryptedCredentialVault(credentialRepository,config.auth.credentialMasterKey,config.auth.credentialKeyVersion);
    const auditLog=new PostgresAuditLog(config.database.url);return{repository,authRepository,queue,credentialVault,auditLog,close:async()=>{await Promise.all([repository.close(),authRepository.close(),queue.close(),credentialRepository.close(),auditLog.close()]);}};
  }
  if(config.environment==='production')throw new Error('SQLite cannot be used in production');
  const repository=new Store(config.database.path,config.defaultTenantId);const authRepository=new SqliteAuthRepository(repository);const queue=new SqliteJobQueue(repository);
  const credentialRepository=new SqliteCredentialRepository(repository);const credentialVault=new EncryptedCredentialVault(credentialRepository,config.auth.credentialMasterKey,config.auth.credentialKeyVersion);
  const auditLog=new SqliteAuditLog(repository);return{repository,authRepository,queue,credentialVault,auditLog,close:async()=>{await Promise.all([authRepository.close(),queue.close(),credentialRepository.close(),auditLog.close()]);await repository.close();}};
}

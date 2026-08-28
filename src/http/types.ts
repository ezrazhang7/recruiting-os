import type { SessionService } from '../application/auth/session-service';
import type { AuditLog } from '../application/ports/audit-log';
import type { CredentialVault } from '../application/ports/credential-vault';
import type { JobQueue } from '../application/ports/job-queue';
import type { RateLimiter } from '../application/ports/rate-limiter';
import type { RecruitingRepository } from '../application/ports/recruiting-repository';
import type { PrivacyRepository } from '../application/ports/privacy-repository';
import type { AppConfig } from '../config/env';
import type { OidcService } from '../infrastructure/auth/oidc-service';
import type { ProviderOAuthService } from '../infrastructure/auth/provider-oauth-service';
import type { MetricsRegistry } from '../infrastructure/observability/metrics';

export interface AppDependencies {
  config: AppConfig;
  repository: RecruitingRepository;
  queue: JobQueue;
  sessionService: SessionService;
  rateLimiter: RateLimiter;
  oidc?: OidcService;
  credentialVault?: CredentialVault;
  providerOAuth?: ProviderOAuthService;
  auditLog?: AuditLog;
  privacyRepository?: PrivacyRepository;
  metrics?: MetricsRegistry;
}

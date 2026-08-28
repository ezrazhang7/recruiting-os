import { SessionService } from '../application/auth/session-service';
import { loadConfig } from '../config/env';
import { OidcService } from '../infrastructure/auth/oidc-service';
import { buildApp } from '../http/app';
import { ProviderOAuthService } from '../infrastructure/auth/provider-oauth-service';
import { createDependencies } from './dependencies';

async function main() {
  const config = loadConfig();
  const dependencies = createDependencies(config);
  await dependencies.validateRuntime();
  const sessionService = new SessionService(
    dependencies.authRepository,
    config.auth.sessionTtlSeconds,
  );
  const oidc =
    config.auth.mode === 'oidc' &&
    config.auth.issuer &&
    config.auth.clientId &&
    config.auth.redirectUri
      ? new OidcService({
          issuer: config.auth.issuer,
          clientId: config.auth.clientId,
          clientSecret: config.auth.clientSecret,
          redirectUri: config.auth.redirectUri,
          allowedEmailDomain: config.auth.allowedEmailDomain,
        })
      : undefined;
  const app = await buildApp({
    config,
    repository: dependencies.repository,
    queue: dependencies.queue,
    sessionService,
    rateLimiter: dependencies.rateLimiter,
    oidc,
    credentialVault: dependencies.credentialVault,
    providerOAuth: new ProviderOAuthService(config.providers),
    auditLog: dependencies.auditLog,
    privacyRepository: dependencies.privacyRepository,
  });
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await dependencies.close();
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
  await app.listen({ host: config.host, port: config.port });
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

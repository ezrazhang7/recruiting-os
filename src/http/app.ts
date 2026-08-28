import { createHash } from 'node:crypto';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';
import type { AppConfig } from '../config/env';
import type { RecruitingRepository } from '../application/ports/recruiting-repository';
import type { JobQueue } from '../application/ports/job-queue';
import type { RateLimiter } from '../application/ports/rate-limiter';
import type { CredentialVault } from '../application/ports/credential-vault';
import type { AuditLog } from '../application/ports/audit-log';
import { SessionService } from '../application/auth/session-service';
import { requireOrganizationAccess, requireRole } from '../application/auth/authorization';
import { AppError, AuthenticationError, RateLimitError, ValidationError } from '../domain/errors';
import type { OidcService, OidcState } from '../infrastructure/auth/oidc-service';
import {
  ProviderOAuthService,
  type ProviderOAuthState,
} from '../infrastructure/auth/provider-oauth-service';
import { stableId } from '../lib/util';
import { organizationDto, opportunityDto } from './public-dto';
import {
  developmentLoginSchema,
  ingestUrlSchema,
  organizationSchema,
  screenshotSchema,
  validateScreenshotBytes,
} from './schemas/requests';
import { appPage, UI_CSS, UI_JS } from './ui';
import { MetricsRegistry } from '../infrastructure/observability/metrics';
import { resolveOrganization } from '../resolver';

const SESSION_COOKIE = '__Host-recruiting_session';
const CSRF_COOKIE = 'recruiting_csrf';
const OIDC_COOKIE = 'recruiting_oidc_state';
const PROVIDER_COOKIE = 'recruiting_provider_state';
const publicPaths = new Set([
  '/',
  '/assets/app.css',
  '/assets/app.js',
  '/health/live',
  '/health/ready',
  '/auth/login',
  '/auth/callback',
  '/auth/development',
]);
const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

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
  metrics?: MetricsRegistry;
}

export async function buildApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const {
    config,
    repository,
    queue,
    sessionService,
    rateLimiter,
    oidc,
    credentialVault,
    providerOAuth,
    auditLog,
  } = dependencies;
  const metrics = dependencies.metrics ?? new MetricsRegistry();
  const sessionCookie = config.environment === 'production' ? SESSION_COOKIE : 'recruiting_session';
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ['req.headers.authorization', 'req.headers.cookie', 'body.base64', 'body.rawText'],
    },
    bodyLimit: config.limits.requestBytes,
    trustProxy: config.trustProxy,
    requestIdHeader: 'x-request-id',
  });
  await app.register(cookie, { secret: config.auth.sessionSecret, hook: 'onRequest' });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
      },
    },
  });
  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin || config.allowedOrigins.includes(origin)) callback(null, true);
      else callback(new Error('Origin is not allowed'), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  });

  app.addHook('onResponse', async (request, reply) => {
    metrics.observe(
      request.method,
      request.routeOptions.url ?? 'unmatched',
      reply.statusCode,
      reply.elapsedTime,
    );
  });

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? request.url;
    const rate = await rateLimiter.consume(
      `ip:${request.ip}`,
      config.limits.requestsPerMinute,
      60_000,
    );
    reply
      .header('x-ratelimit-remaining', rate.remaining)
      .header('x-ratelimit-reset', Math.ceil(rate.resetAt / 1000));
    if (!rate.allowed) throw new RateLimitError();
    if (
      publicPaths.has(path) ||
      (request.method === 'GET' && /^\/api\/connectors\/[^/]+\/callback$/.test(path)) ||
      request.method === 'OPTIONS'
    )
      return;
    const authentication = await sessionService.authenticate(request.cookies[sessionCookie]);
    if (!authentication) throw new AuthenticationError();
    request.authentication = authentication;
    const userRate = await rateLimiter.consume(
      `user:${authentication.principal.tenantId}:${authentication.principal.userId}`,
      config.limits.requestsPerMinute,
      60_000,
    );
    if (!userRate.allowed) throw new RateLimitError();
    if (unsafeMethods.has(request.method)) {
      const token = headerString(request.headers['x-csrf-token']);
      if (!sessionService.verifyCsrf(authentication, token))
        throw new AppError('CSRF validation failed', 403, 'CSRF_FAILED');
    }
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error, requestId: request.id }, 'request failed');
    if (error instanceof ZodError)
      return reply.status(422).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Request validation failed',
          details: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
        requestId: request.id,
      });
    if (error instanceof AppError)
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.expose ? error.message : 'Request failed' },
        requestId: request.id,
      });
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Request failed' },
      requestId: request.id,
    });
  });

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async () => {
    await repository.listOrganizations(config.defaultTenantId);
    return { status: 'ready' };
  });
  app.get('/', async (_request, reply) => reply.type('text/html').send(appPage(config.auth.mode)));
  app.get('/assets/app.css', async (_request, reply) =>
    reply.type('text/css; charset=utf-8').send(UI_CSS),
  );
  app.get('/assets/app.js', async (_request, reply) =>
    reply.type('application/javascript; charset=utf-8').send(UI_JS),
  );

  app.get('/auth/login', async (request, reply) => {
    if (!oidc) throw new AppError('OIDC is not configured', 404, 'OIDC_NOT_CONFIGURED');
    const returnTo =
      typeof (request.query as any)?.returnTo === 'string' ? (request.query as any).returnTo : '/';
    const authorization = await oidc.authorization(returnTo);
    setSignedCookie(
      reply,
      OIDC_COOKIE,
      JSON.stringify(authorization.state),
      config.environment === 'production',
      600,
    );
    return reply.redirect(authorization.url);
  });
  app.get('/auth/callback', async (request, reply) => {
    if (!oidc) throw new AppError('OIDC is not configured', 404, 'OIDC_NOT_CONFIGURED');
    const query = z
      .object({ code: z.string().min(1), state: z.string().min(1) })
      .parse(request.query);
    const signed = request.cookies[OIDC_COOKIE];
    if (!signed) throw new AppError('OIDC state is missing', 400, 'OIDC_STATE_MISSING');
    const unsigned = request.unsignCookie(signed);
    if (!unsigned.valid) throw new AppError('OIDC state is invalid', 400, 'OIDC_STATE_INVALID');
    const state = JSON.parse(unsigned.value) as OidcState;
    if (state.state !== query.state)
      throw new AppError('OIDC state mismatch', 400, 'OIDC_STATE_INVALID');
    const identity = await oidc.callback(query.code, state);
    const issued = await sessionService.issue(identity, config.defaultTenantId);
    setSessionCookies(
      reply,
      sessionCookie,
      issued.token,
      issued.csrfToken,
      config.environment === 'production',
      config.auth.sessionTtlSeconds,
    );
    reply.clearCookie(OIDC_COOKIE, { path: '/auth' });
    return reply.redirect(state.returnTo);
  });
  app.post('/auth/development', async (request, reply) => {
    if (config.auth.mode !== 'development' || config.environment === 'production')
      throw new AppError('Not found', 404, 'NOT_FOUND');
    const body = developmentLoginSchema.parse(request.body);
    if (!body.email.toLowerCase().endsWith(`@${config.auth.allowedEmailDomain.toLowerCase()}`))
      throw new ValidationError('Email domain is not allowed');
    const issued = await sessionService.issue(
      {
        issuer: 'development',
        subject: body.email.toLowerCase(),
        email: body.email.toLowerCase(),
        displayName: body.displayName,
      },
      config.defaultTenantId,
      ['platform_admin'],
    );
    setSessionCookies(
      reply,
      sessionCookie,
      issued.token,
      issued.csrfToken,
      false,
      config.auth.sessionTtlSeconds,
    );
    return { user: issued.principal, csrfToken: issued.csrfToken };
  });
  app.post('/auth/logout', async (request, reply) => {
    const auth = authentication(request);
    await auditLog?.write({
      tenantId: auth.principal.tenantId,
      actorId: auth.principal.userId,
      action: 'session.revoke',
      resourceType: 'session',
      resourceId: auth.principal.sessionId,
      requestId: request.id,
    });
    await sessionService.revoke(auth.principal);
    reply.clearCookie(sessionCookie, { path: '/' }).clearCookie(CSRF_COOKIE, { path: '/' });
    return { ok: true };
  });

  const providerSchema = z.enum(['gmail', 'groupme', 'instagram', 'linkedin']);
  app.post('/api/connectors/:provider/connect', async (request, reply) => {
    if (!providerOAuth)
      throw new AppError('Connector OAuth is unavailable', 503, 'CONNECTOR_UNAVAILABLE');
    const principal = authentication(request).principal;
    const { provider } = z.object({ provider: providerSchema }).parse(request.params);
    if (!providerOAuth.configured(provider))
      throw new AppError('Connector is not configured', 503, 'CONNECTOR_NOT_CONFIGURED');
    await auditLog?.write({
      tenantId: principal.tenantId,
      actorId: principal.userId,
      action: 'connector.connect.start',
      resourceType: 'connector',
      resourceId: provider,
      requestId: request.id,
    });
    const authorization = providerOAuth.authorization(
      provider,
      principal.userId,
      principal.tenantId,
    );
    setSignedCookie(
      reply,
      PROVIDER_COOKIE,
      JSON.stringify(authorization.state),
      config.environment === 'production',
      600,
      '/api/connectors',
    );
    return { authorizationUrl: authorization.url };
  });
  app.get('/api/connectors/:provider/callback', async (request, reply) => {
    if (!providerOAuth || !credentialVault)
      throw new AppError('Connector OAuth is unavailable', 503, 'CONNECTOR_UNAVAILABLE');
    const session = await sessionService.authenticate(request.cookies[sessionCookie]);
    if (!session) throw new AuthenticationError();
    const { provider } = z.object({ provider: providerSchema }).parse(request.params);
    const query = z
      .object({ code: z.string().min(1), state: z.string().min(1) })
      .parse(request.query);
    const signed = request.cookies[PROVIDER_COOKIE];
    if (!signed) throw new AppError('OAuth state is missing', 400, 'OAUTH_STATE_MISSING');
    const unsigned = request.unsignCookie(signed);
    if (!unsigned.valid) throw new AppError('OAuth state is invalid', 400, 'OAUTH_STATE_INVALID');
    const state = JSON.parse(unsigned.value) as ProviderOAuthState;
    if (
      state.state !== query.state ||
      state.provider !== provider ||
      state.userId !== session.principal.userId ||
      state.tenantId !== session.principal.tenantId
    )
      throw new AppError('OAuth state mismatch', 400, 'OAUTH_STATE_INVALID');
    const credential = await providerOAuth.callback(provider, query.code, state);
    await auditLog?.write({
      tenantId: state.tenantId,
      actorId: state.userId,
      action: 'connector.connect.complete',
      resourceType: 'connector',
      resourceId: provider,
      requestId: request.id,
    });
    await credentialVault.put(state.tenantId, state.userId, provider, credential);
    reply.clearCookie(PROVIDER_COOKIE, { path: '/api/connectors' });
    return reply.redirect(state.returnTo);
  });
  app.get('/api/connectors/:provider/status', async (request) => {
    if (!credentialVault)
      throw new AppError('Credential vault is unavailable', 503, 'CONNECTOR_UNAVAILABLE');
    const principal = authentication(request).principal;
    const { provider } = z.object({ provider: providerSchema }).parse(request.params);
    const credential = await credentialVault.get(principal.tenantId, principal.userId, provider);
    return {
      provider,
      connected: Boolean(credential),
      expiresAt: credential?.expiresAt,
      scopes: credential?.scopes ?? [],
    };
  });
  app.delete('/api/connectors/:provider', async (request) => {
    if (!credentialVault)
      throw new AppError('Credential vault is unavailable', 503, 'CONNECTOR_UNAVAILABLE');
    const principal = authentication(request).principal;
    const { provider } = z.object({ provider: providerSchema }).parse(request.params);
    await auditLog?.write({
      tenantId: principal.tenantId,
      actorId: principal.userId,
      action: 'connector.revoke',
      resourceType: 'connector',
      resourceId: provider,
      requestId: request.id,
    });
    await credentialVault.revoke(principal.tenantId, principal.userId, provider);
    return { ok: true };
  });
  app.post('/api/connectors/:provider/sync', async (request, reply) => {
    const principal = authentication(request).principal;
    const { provider } = z.object({ provider: providerSchema }).parse(request.params);
    const body = z
      .object({
        organizationId: z.string().min(2).max(80),
        scope: z.string().min(1).max(200).optional(),
      })
      .strict()
      .parse(request.body);
    requireOrganizationAccess(principal, body.organizationId);
    if (provider === 'groupme' && !body.scope)
      throw new ValidationError('GroupMe sync requires a group ID scope');
    const job = await queue.enqueue({
      tenantId: principal.tenantId,
      type: 'connector.sync',
      idempotencyKey: idempotencyKey(request, { provider, ...body }),
      payload: { provider, userId: principal.userId, ...body },
    });
    await auditLog?.write({
      tenantId: principal.tenantId,
      actorId: principal.userId,
      action: 'connector.sync.queued',
      resourceType: 'job',
      resourceId: job.id,
      requestId: request.id,
      metadata: { provider, organizationId: body.organizationId },
    });
    reply.status(202);
    return { jobId: job.id, status: job.status };
  });

  app.get('/api/me', async (request) => ({ user: authentication(request).principal }));
  app.get('/api/admin/metrics', async (request, reply) => {
    const principal = authentication(request).principal;
    requireRole(principal, ['platform_admin']);
    const jobStats = await queue.stats(principal.tenantId);
    const queueMetrics = `# HELP recruiting_os_jobs Jobs by state for the authenticated tenant.
# TYPE recruiting_os_jobs gauge
recruiting_os_jobs{status="queued"} ${jobStats.queued}
recruiting_os_jobs{status="running"} ${jobStats.running}
recruiting_os_jobs{status="retryable_failed"} ${jobStats.retryableFailed}
recruiting_os_jobs{status="dead_letter"} ${jobStats.deadLetter}
# HELP recruiting_os_oldest_ready_job_age_seconds Oldest ready job age.
# TYPE recruiting_os_oldest_ready_job_age_seconds gauge
recruiting_os_oldest_ready_job_age_seconds ${jobStats.oldestReadyAgeSeconds}
`;
    return reply
      .type('text/plain; version=0.0.4; charset=utf-8')
      .send(metrics.render() + queueMetrics);
  });
  app.get('/api/dashboard', async (request) => {
    const principal = authentication(request).principal;
    const organizations = await repository.listOrganizations(principal.tenantId);
    return {
      organizations: await Promise.all(
        organizations.map(async (organization) => ({
          ...organizationDto(organization),
          opportunities: (
            await repository.listOpportunities(organization.id, principal.tenantId)
          ).map(opportunityDto),
        })),
      ),
    };
  });
  app.get('/api/organizations/:id', async (request) => {
    const principal = authentication(request).principal;
    const { id } = z.object({ id: z.string().min(1).max(80) }).parse(request.params);
    const organization = await repository.getOrganization(id, principal.tenantId);
    if (!organization) throw new AppError('Organization not found', 404, 'NOT_FOUND');
    return {
      organization: organizationDto(organization),
      opportunities: (await repository.listOpportunities(id, principal.tenantId)).map(
        opportunityDto,
      ),
    };
  });
  app.get('/api/admin/organizations/:id/evidence', async (request) => {
    const principal = authentication(request).principal;
    const { id } = z.object({ id: z.string().min(1).max(80) }).parse(request.params);
    requireOrganizationAccess(principal, id);
    await auditLog?.write({
      tenantId: principal.tenantId,
      actorId: principal.userId,
      action: 'evidence.read',
      resourceType: 'organization',
      resourceId: id,
      requestId: request.id,
    });
    return { claims: await repository.listClaims(id, principal.tenantId) };
  });
  app.post(
    '/api/admin/organizations/:id/opportunities/:opportunityId/override',
    async (request, reply) => {
      const principal = authentication(request).principal;
      const { id, opportunityId } = z
        .object({
          id: z.string().min(1).max(80),
          opportunityId: z.string().min(1).max(80),
        })
        .parse(request.params);
      requireOrganizationAccess(principal, id);
      const body = z
        .object({
          patch: z
            .object({
              title: z.string().min(1).max(160).optional(),
              deadlineAt: z.string().datetime({ offset: true }).nullable().optional(),
              startsAt: z.string().datetime({ offset: true }).nullable().optional(),
              url: z.string().url().nullable().optional(),
              stale: z.boolean().optional(),
            })
            .strict(),
          reason: z.string().min(8).max(500),
        })
        .strict()
        .parse(request.body);
      const existing = (await repository.listOpportunities(id, principal.tenantId)).find(
        (item) => item.id === opportunityId,
      );
      if (!existing) throw new AppError('Opportunity not found', 404, 'NOT_FOUND');
      const patch = Object.fromEntries(
        Object.entries(body.patch).map(([key, value]) => [key, value ?? undefined]),
      );
      const override = {
        id: stableId(
          'override',
          `${principal.tenantId}:${opportunityId}:${Date.now()}:${principal.userId}`,
        ),
        tenantId: principal.tenantId,
        opportunityId,
        organizationId: id,
        actorId: principal.userId,
        patch,
        reason: body.reason,
        createdAt: new Date().toISOString(),
      };
      await repository.transaction(async () => {
        await repository.putOpportunityOverride(override, principal.tenantId);
        await resolveOrganization(repository, id, new Date(), principal.tenantId);
      });
      await auditLog?.write({
        tenantId: principal.tenantId,
        actorId: principal.userId,
        action: 'opportunity.override',
        resourceType: 'opportunity',
        resourceId: opportunityId,
        requestId: request.id,
        metadata: { organizationId: id, reason: body.reason },
      });
      reply.status(201);
      return {
        opportunity: (await repository.listOpportunities(id, principal.tenantId)).find(
          (item) => item.id === opportunityId,
        ),
      };
    },
  );
  app.post('/api/organizations', async (request, reply) => {
    const principal = authentication(request).principal;
    requireRole(principal, ['platform_admin']);
    const body = organizationSchema.parse(request.body);
    await auditLog?.write({
      tenantId: principal.tenantId,
      actorId: principal.userId,
      action: 'organization.upsert',
      resourceType: 'organization',
      resourceId: body.id,
      requestId: request.id,
    });
    await repository.upsertOrganization(body, principal.tenantId);
    reply.status(201);
    return { organization: organizationDto({ ...body, tenantId: principal.tenantId }) };
  });
  app.post('/api/ingest/url', async (request, reply) => {
    const principal = authentication(request).principal;
    const body = ingestUrlSchema.parse(request.body);
    requireOrganizationAccess(principal, body.organizationId);
    const job = await queue.enqueue({
      tenantId: principal.tenantId,
      type: 'ingest.url',
      idempotencyKey: idempotencyKey(request, body),
      payload: body,
    });
    await auditLog?.write({
      tenantId: principal.tenantId,
      actorId: principal.userId,
      action: 'ingestion.url.queued',
      resourceType: 'job',
      resourceId: job.id,
      requestId: request.id,
      metadata: { organizationId: body.organizationId },
    });
    reply.status(202);
    return { jobId: job.id, status: job.status };
  });
  app.post('/api/ingest/screenshot', async (request, reply) => {
    const principal = authentication(request).principal;
    const body = screenshotSchema.parse(request.body);
    requireOrganizationAccess(principal, body.organizationId);
    try {
      validateScreenshotBytes(body.base64, body.mimeType, config.limits.screenshotBytes);
    } catch (error) {
      throw new ValidationError(error instanceof Error ? error.message : 'Invalid screenshot');
    }
    const job = await queue.enqueue({
      tenantId: principal.tenantId,
      type: 'ingest.screenshot',
      idempotencyKey: idempotencyKey(request, {
        ...body,
        base64: createHash('sha256').update(body.base64).digest('hex'),
      }),
      payload: body,
    });
    await auditLog?.write({
      tenantId: principal.tenantId,
      actorId: principal.userId,
      action: 'ingestion.screenshot.queued',
      resourceType: 'job',
      resourceId: job.id,
      requestId: request.id,
      metadata: { organizationId: body.organizationId },
    });
    reply.status(202);
    return { jobId: job.id, status: job.status };
  });
  return app;
}

function authentication(request: FastifyRequest) {
  if (!request.authentication) throw new AuthenticationError();
  return request.authentication;
}
function headerString(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}
function idempotencyKey(request: FastifyRequest, body: unknown) {
  return (
    headerString(request.headers['x-idempotency-key']) ??
    stableId(
      'idem',
      `${authentication(request).principal.userId}:${JSON.stringify(body)}:${Math.floor(Date.now() / 300_000)}`,
    )
  );
}
function setSignedCookie(
  reply: FastifyReply,
  name: string,
  value: string,
  secure: boolean,
  maxAge: number,
  path = '/auth',
) {
  reply.setCookie(name, value, {
    path,
    httpOnly: true,
    secure,
    sameSite: 'lax',
    signed: true,
    maxAge,
  });
}
function setSessionCookies(
  reply: FastifyReply,
  cookieName: string,
  token: string,
  csrf: string,
  secure: boolean,
  maxAge: number,
) {
  reply.setCookie(cookieName, token, {
    path: '/',
    httpOnly: true,
    secure,
    sameSite: 'lax',
    maxAge,
  });
  reply.setCookie(CSRF_COOKIE, csrf, {
    path: '/',
    httpOnly: false,
    secure,
    sameSite: 'strict',
    maxAge,
  });
}

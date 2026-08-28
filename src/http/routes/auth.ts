import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, ValidationError } from '../../domain/errors';
import { developmentLoginSchema } from '../schemas/requests';
import {
  authentication,
  CSRF_COOKIE,
  OIDC_COOKIE,
  setSessionCookies,
  setSignedCookie,
} from '../request-context';
import type { AppDependencies } from '../types';
import { initialRolesForIdentity } from '../../application/auth/initial-roles';
import { safeRelativeReturnTo } from '../../lib/safe-url';

const oidcStateSchema = z.object({
  state: z.string().min(1),
  nonce: z.string().min(1),
  verifier: z.string().min(1),
  returnTo: z.string().startsWith('/'),
});

export function registerAuthRoutes(
  app: FastifyInstance,
  dependencies: AppDependencies,
  sessionCookie: string,
): void {
  const { config, sessionService, oidc, auditLog } = dependencies;

  app.get('/auth/login', async (request, reply) => {
    if (!oidc) throw new AppError('OIDC is not configured', 404, 'OIDC_NOT_CONFIGURED');
    const returnTo =
      typeof (request.query as { returnTo?: unknown })?.returnTo === 'string'
        ? (request.query as { returnTo: string }).returnTo
        : '/';
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
    let state: z.infer<typeof oidcStateSchema>;
    try {
      state = oidcStateSchema.parse(JSON.parse(unsigned.value));
    } catch {
      throw new AppError('OIDC state is invalid', 400, 'OIDC_STATE_INVALID');
    }
    if (state.state !== query.state)
      throw new AppError('OIDC state mismatch', 400, 'OIDC_STATE_INVALID');
    const identity = await oidc.callback(query.code, state);
    const issued = await sessionService.issue(
      identity,
      config.defaultTenantId,
      initialRolesForIdentity(identity.email, config.auth.initialPlatformAdminEmails),
    );
    setSessionCookies(
      reply,
      sessionCookie,
      issued.token,
      issued.csrfToken,
      config.environment === 'production',
      config.auth.sessionTtlSeconds,
    );
    reply.clearCookie(OIDC_COOKIE, { path: '/auth' });
    return reply.redirect(safeRelativeReturnTo(state.returnTo));
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
    await sessionService.revoke(auth.principal);
    await auditLog?.write({
      tenantId: auth.principal.tenantId,
      actorId: auth.principal.userId,
      action: 'session.revoke',
      resourceType: 'session',
      resourceId: auth.principal.sessionId,
      requestId: request.id,
    });
    reply.clearCookie(sessionCookie, { path: '/' }).clearCookie(CSRF_COOKIE, { path: '/' });
    return { ok: true };
  });
}

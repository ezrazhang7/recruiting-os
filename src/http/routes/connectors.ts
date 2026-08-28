import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOrganizationAccess } from '../../application/auth/authorization';
import { AppError, AuthenticationError, ValidationError } from '../../domain/errors';
import { DATA_POLICY_VERSION } from '../../domain/data-policy';
import {
  authentication,
  idempotencyKey,
  PROVIDER_COOKIE,
  setSignedCookie,
} from '../request-context';
import type { AppDependencies } from '../types';
import { safeRelativeReturnTo } from '../../lib/safe-url';

const providerSchema = z.enum(['gmail', 'groupme', 'instagram', 'linkedin']);
const providerStateSchema = z.object({
  provider: providerSchema,
  state: z.string().min(1),
  verifier: z.string().min(1),
  userId: z.string().min(1),
  tenantId: z.string().min(1),
  returnTo: z.string().startsWith('/'),
});

export function registerConnectorRoutes(
  app: FastifyInstance,
  dependencies: AppDependencies,
  sessionCookie: string,
): void {
  const { config, sessionService, queue, credentialVault, providerOAuth, auditLog } = dependencies;

  app.post('/api/connectors/:provider/connect', async (request, reply) => {
    if (!providerOAuth)
      throw new AppError('Connector OAuth is unavailable', 503, 'CONNECTOR_UNAVAILABLE');
    const principal = authentication(request).principal;
    const { provider } = z.object({ provider: providerSchema }).parse(request.params);
    const consent = z
      .object({ consentToProcess: z.literal(true) })
      .strict()
      .parse(request.body);
    if (!providerOAuth.configured(provider))
      throw new AppError('Connector is not configured', 503, 'CONNECTOR_NOT_CONFIGURED');
    const authorization = providerOAuth.authorization(
      provider,
      principal.userId,
      principal.tenantId,
    );
    await auditLog?.write({
      tenantId: principal.tenantId,
      actorId: principal.userId,
      action: 'connector.connect.start',
      resourceType: 'connector',
      resourceId: provider,
      requestId: request.id,
      metadata: { consentToProcess: consent.consentToProcess, policyVersion: DATA_POLICY_VERSION },
    });
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
    let state: z.infer<typeof providerStateSchema>;
    try {
      state = providerStateSchema.parse(JSON.parse(unsigned.value));
    } catch {
      throw new AppError('OAuth state is invalid', 400, 'OAUTH_STATE_INVALID');
    }
    if (
      state.state !== query.state ||
      state.provider !== provider ||
      state.userId !== session.principal.userId ||
      state.tenantId !== session.principal.tenantId
    )
      throw new AppError('OAuth state mismatch', 400, 'OAUTH_STATE_INVALID');
    const credential = await providerOAuth.callback(provider, query.code, state);
    await credentialVault.put(state.tenantId, state.userId, provider, credential);
    await auditLog?.write({
      tenantId: state.tenantId,
      actorId: state.userId,
      action: 'connector.connect.complete',
      resourceType: 'connector',
      resourceId: provider,
      requestId: request.id,
    });
    reply.clearCookie(PROVIDER_COOKIE, { path: '/api/connectors' });
    return reply.redirect(safeRelativeReturnTo(state.returnTo, '/?connectors=1'));
  });

  app.get('/api/connectors/:provider/status', async (request) => {
    const vault = requireCredentialVault(credentialVault);
    const principal = authentication(request).principal;
    const { provider } = z.object({ provider: providerSchema }).parse(request.params);
    const credential = await vault.get(principal.tenantId, principal.userId, provider);
    return {
      provider,
      connected: Boolean(credential),
      expiresAt: credential?.expiresAt,
      scopes: credential?.scopes ?? [],
    };
  });

  app.delete('/api/connectors/:provider', async (request) => {
    const vault = requireCredentialVault(credentialVault);
    const principal = authentication(request).principal;
    const { provider } = z.object({ provider: providerSchema }).parse(request.params);
    await vault.revoke(principal.tenantId, principal.userId, provider);
    const cancelledJobs = await queue.cancelPending({
      tenantId: principal.tenantId,
      type: 'connector.sync',
      payload: { provider, userId: principal.userId },
    });
    await auditLog?.write({
      tenantId: principal.tenantId,
      actorId: principal.userId,
      action: 'connector.revoke',
      resourceType: 'connector',
      resourceId: provider,
      requestId: request.id,
      metadata: { cancelledJobs },
    });
    return { ok: true, cancelledJobs };
  });

  app.post('/api/connectors/:provider/sync', async (request, reply) => {
    const vault = requireCredentialVault(credentialVault);
    const principal = authentication(request).principal;
    const { provider } = z.object({ provider: providerSchema }).parse(request.params);
    const body = z
      .object({
        organizationId: z.string().min(2).max(80),
        scope: z.string().min(1).max(200).optional(),
        recurring: z.boolean().default(true),
      })
      .strict()
      .parse(request.body);
    requireOrganizationAccess(principal, body.organizationId);
    if (provider === 'groupme' && !body.scope)
      throw new ValidationError('GroupMe sync requires a group ID scope');
    if (!(await vault.get(principal.tenantId, principal.userId, provider)))
      throw new AppError('Connector is not connected', 409, 'CONNECTOR_NOT_CONNECTED');
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
}

function requireCredentialVault(vault: AppDependencies['credentialVault']) {
  if (!vault) throw new AppError('Credential vault is unavailable', 503, 'CONNECTOR_UNAVAILABLE');
  return vault;
}

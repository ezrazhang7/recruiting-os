import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../domain/errors';
import { CSRF_COOKIE, authentication } from '../request-context';
import type { AppDependencies } from '../types';

export function registerPrivacyRoutes(
  app: FastifyInstance,
  dependencies: AppDependencies,
  sessionCookie: string,
): void {
  const { privacyRepository, auditLog } = dependencies;

  app.get('/api/me/export', async (request, reply) => {
    if (!privacyRepository)
      throw new AppError('Account export is unavailable', 503, 'PRIVACY_UNAVAILABLE');
    const principal = authentication(request).principal;
    const data = await privacyRepository.exportAccount(principal.tenantId, principal.userId);
    if (!data) throw new AppError('Account not found', 404, 'NOT_FOUND');
    await auditLog?.write({
      tenantId: principal.tenantId,
      actorId: principal.userId,
      action: 'privacy.export',
      resourceType: 'account',
      requestId: request.id,
    });
    return reply
      .header('content-disposition', `attachment; filename="recruiting-os-account-export.json"`)
      .header('cache-control', 'no-store')
      .send(data);
  });

  app.delete('/api/me', async (request, reply) => {
    if (!privacyRepository)
      throw new AppError('Account deletion is unavailable', 503, 'PRIVACY_UNAVAILABLE');
    z.object({ confirmation: z.literal('DELETE_MY_ACCOUNT') })
      .strict()
      .parse(request.body);
    const principal = authentication(request).principal;
    const result = await privacyRepository.eraseAccount(
      principal.tenantId,
      principal.userId,
      request.id,
    );
    if (!result.membershipDeleted) throw new AppError('Account not found', 404, 'NOT_FOUND');
    reply
      .clearCookie(sessionCookie, { path: '/' })
      .clearCookie(CSRF_COOKIE, { path: '/' })
      .status(202);
    return {
      ok: true,
      reconciliationJobs: result.reconciliationJobIds,
      deleted: result,
    };
  });
}

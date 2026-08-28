import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOrganizationAccess, requireRole } from '../../application/auth/authorization';
import { AppError, ValidationError } from '../../domain/errors';
import { DATA_POLICY_VERSION } from '../../domain/data-policy';
import { stableId } from '../../lib/util';
import { safeHttpUrl } from '../../lib/safe-url';
import { resolveOrganization } from '../../resolver';
import { authentication, idempotencyKey } from '../request-context';
import { organizationDto, opportunityDto } from '../public-dto';
import {
  ingestUrlSchema,
  organizationSchema,
  screenshotSchema,
  validateScreenshotBytes,
} from '../schemas/requests';
import type { AppDependencies } from '../types';

export function registerRecruitingRoutes(
  app: FastifyInstance,
  dependencies: AppDependencies,
): void {
  const { config, repository, queue, auditLog } = dependencies;

  app.get('/api/me', async (request) => ({ user: authentication(request).principal }));

  app.get('/api/admin/metrics', async (request, reply) => {
    const principal = authentication(request).principal;
    requireRole(principal, ['platform_admin']);
    return reply
      .type('text/plain; version=0.0.4; charset=utf-8')
      .send(await renderMetrics(dependencies, principal.tenantId));
  });

  app.get('/metrics', async (_request, reply) =>
    reply
      .type('text/plain; version=0.0.4; charset=utf-8')
      .send(await renderMetrics(dependencies, config.defaultTenantId)),
  );

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
    const claims = await repository.listClaims(id, principal.tenantId);
    await auditLog?.write({
      tenantId: principal.tenantId,
      actorId: principal.userId,
      action: 'evidence.read',
      resourceType: 'organization',
      resourceId: id,
      requestId: request.id,
    });
    return { claims };
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
              url: z
                .string()
                .url()
                .max(2_048)
                .refine(
                  (value) => Boolean(safeHttpUrl(value)),
                  'URL must use HTTP(S) without credentials',
                )
                .nullable()
                .optional(),
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
    await repository.upsertOrganization(body, principal.tenantId);
    await auditLog?.write({
      tenantId: principal.tenantId,
      actorId: principal.userId,
      action: 'organization.upsert',
      resourceType: 'organization',
      resourceId: body.id,
      requestId: request.id,
    });
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
      payload: { ...body, userId: principal.userId },
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

  app.post(
    '/api/ingest/screenshot',
    { bodyLimit: screenshotRequestBodyLimit(config.limits.screenshotBytes) },
    async (request, reply) => {
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
        payload: { ...body, userId: principal.userId },
      });
      await auditLog?.write({
        tenantId: principal.tenantId,
        actorId: principal.userId,
        action: 'ingestion.screenshot.queued',
        resourceType: 'job',
        resourceId: job.id,
        requestId: request.id,
        metadata: {
          organizationId: body.organizationId,
          consentToProcess: body.consentToProcess,
          policyVersion: DATA_POLICY_VERSION,
        },
      });
      reply.status(202);
      return { jobId: job.id, status: job.status };
    },
  );
}

function screenshotRequestBodyLimit(maxScreenshotBytes: number): number {
  const base64Bytes = Math.ceil(maxScreenshotBytes / 3) * 4;
  return base64Bytes + 16_384;
}

async function renderMetrics(dependencies: AppDependencies, tenantId: string): Promise<string> {
  const jobStats = await dependencies.queue.stats(tenantId);
  const queueMetrics = `# HELP recruiting_os_jobs Jobs by state for the configured tenant.
# TYPE recruiting_os_jobs gauge
recruiting_os_jobs{status="queued"} ${jobStats.queued}
recruiting_os_jobs{status="running"} ${jobStats.running}
recruiting_os_jobs{status="retryable_failed"} ${jobStats.retryableFailed}
recruiting_os_jobs{status="dead_letter"} ${jobStats.deadLetter}
recruiting_os_jobs{status="cancelled"} ${jobStats.cancelled}
# HELP recruiting_os_oldest_ready_job_age_seconds Oldest ready job age.
# TYPE recruiting_os_oldest_ready_job_age_seconds gauge
recruiting_os_oldest_ready_job_age_seconds ${jobStats.oldestReadyAgeSeconds}
`;
  return (dependencies.metrics?.render() ?? '') + queueMetrics;
}

import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config/env';
import { OpenAIExtractor } from '../extractor';
import { IngestionService } from '../ingest';
import { WebConnector } from '../connectors/web';
import { screenshotSource } from '../connectors/manual';
import { SafeHttpClient } from '../infrastructure/outbound-http/safe-http-client';
import { createLogger } from '../infrastructure/observability/logger';
import { createDependencies } from './dependencies';
import { GmailConnector } from '../connectors/gmail';
import { GroupMeConnector } from '../connectors/groupme';
import { InstagramConnector } from '../connectors/instagram';
import { LinkedInConnector } from '../connectors/linkedin';
import type { SourceItem } from '../domain/models';
import { ProviderOAuthService } from '../infrastructure/auth/provider-oauth-service';
import { RefreshingCredentialService } from '../application/connectors/refreshing-credential-service';
import {
  ConnectorSyncScheduler,
  type ConnectorSyncPayload,
} from '../application/connectors/connector-sync-scheduler';
import { z } from 'zod';
import { JobLeaseHeartbeat } from '../application/queue/job-lease-heartbeat';
import { ProviderHttpClient } from '../infrastructure/outbound-http/provider-http-client';

const connectorSyncPayloadSchema = z.object({
  provider: z.enum(['gmail', 'groupme', 'instagram', 'linkedin']),
  userId: z.string().min(1),
  organizationId: z.string().min(1),
  scope: z.string().optional(),
  recurring: z.boolean().optional(),
});

async function main() {
  const config = loadConfig();
  const dependencies = createDependencies(config, 'worker');
  const logger = createLogger(config.logLevel);
  const workerId = `worker-${randomUUID()}`;
  const web = new WebConnector(
    new SafeHttpClient({ maxResponseBytes: config.limits.fetchBytes }).fetch,
  );
  const providerHttp = {
    gmail: new ProviderHttpClient({
      allowedHosts: new Set(['gmail.googleapis.com']),
      maxResponseBytes: config.limits.providerResponseBytes,
    }).fetch,
    groupme: new ProviderHttpClient({
      allowedHosts: new Set(['api.groupme.com']),
      maxResponseBytes: config.limits.providerResponseBytes,
    }).fetch,
    instagram: new ProviderHttpClient({
      allowedHosts: new Set(['graph.facebook.com']),
      maxResponseBytes: config.limits.providerResponseBytes,
    }).fetch,
    linkedin: new ProviderHttpClient({
      allowedHosts: new Set(['api.linkedin.com']),
      maxResponseBytes: config.limits.providerResponseBytes,
    }).fetch,
    openai: new ProviderHttpClient({
      allowedHosts: new Set(['api.openai.com']),
      timeoutMs: 30_000,
      maxResponseBytes: config.limits.providerResponseBytes,
    }).fetch,
  };
  const ingestion = new IngestionService(
    dependencies.repository,
    new OpenAIExtractor(config.openai.apiKey, config.openai.model, providerHttp.openai),
    web,
  );
  const credentials = new RefreshingCredentialService(
    dependencies.credentialVault,
    new ProviderOAuthService(config.providers),
    dependencies.auditLog,
  );
  const connectorScheduler = new ConnectorSyncScheduler(
    dependencies.queue,
    dependencies.credentialVault,
    config.limits.connectorSyncIntervalSeconds,
  );
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  while (!stopping) {
    const job = await dependencies.queue.leaseNext(workerId, 60);
    if (!job) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }
    const heartbeat = new JobLeaseHeartbeat(dependencies.queue, job);
    heartbeat.start();
    let processingError: unknown;
    let recurringPayload: ConnectorSyncPayload | undefined;
    try {
      if (job.type === 'ingest.url') {
        const payload = job.payload as { organizationId: string; url: string };
        const fetched = await web.fetchSource(payload.organizationId, payload.url);
        fetched.source.tenantId = job.tenantId;
        await ingestion.ingest(fetched.source, { followLinks: true, maxDepth: 2 });
      } else if (job.type === 'ingest.screenshot') {
        const payload = job.payload as {
          organizationId: string;
          base64: string;
          mimeType?: string;
          note?: string;
          url?: string;
          publishedAt?: string;
        };
        const source = screenshotSource(payload.organizationId, payload);
        source.tenantId = job.tenantId;
        await ingestion.ingest(source, { followLinks: true, maxDepth: 2 });
      } else if (job.type === 'connector.sync') {
        const payload: ConnectorSyncPayload = connectorSyncPayloadSchema.parse(job.payload);
        const credential = await credentials.getValid(
          job.tenantId,
          payload.userId,
          payload.provider,
          job.id,
        );
        if (!credential) throw new Error(`${payload.provider} is not connected`);
        const organization = await dependencies.repository.getOrganization(
          payload.organizationId,
          job.tenantId,
        );
        if (!organization) throw new Error('Organization not found');
        let sources: SourceItem[] = [];
        if (payload.provider === 'gmail') {
          const connector = new GmailConnector(
            credential.accessToken,
            config.connectorRuntime.gmailUserId,
            providerHttp.gmail,
          );
          sources = await connector.synchronize(
            dependencies.repository,
            payload.organizationId,
            `("${organization.name}" OR recruiting OR application)`,
            job.tenantId,
          );
        } else if (payload.provider === 'groupme') {
          if (!payload.scope) throw new Error('GroupMe sync requires a group ID scope');
          sources = await new GroupMeConnector(
            credential.accessToken,
            providerHttp.groupme,
          ).syncGroup(dependencies.repository, payload.organizationId, payload.scope, job.tenantId);
        } else if (payload.provider === 'instagram') {
          if (!organization.instagramHandle || !config.connectorRuntime.metaIgUserId)
            throw new Error('Instagram organization handle or META_IG_USER_ID is missing');
          sources = (
            await new InstagramConnector(
              credential.accessToken,
              config.connectorRuntime.metaIgUserId,
              config.connectorRuntime.metaApiVersion,
              providerHttp.instagram,
            ).sourcesForOrganization(payload.organizationId, organization.instagramHandle)
          ).sources;
        } else if (payload.provider === 'linkedin') {
          if (!organization.linkedinUrl) throw new Error('LinkedIn organization URL is missing');
          const connector = new LinkedInConnector(
            credential.accessToken,
            config.connectorRuntime.linkedinVersion,
            providerHttp.linkedin,
          );
          const urn = await connector.resolveOrganizationUrn(organization.linkedinUrl);
          sources = await connector.posts(payload.organizationId, urn);
        }
        for (const source of sources) {
          source.tenantId = job.tenantId;
          await ingestion.ingest(source, { followLinks: true, maxDepth: 2 });
        }
        recurringPayload = payload;
      } else throw new Error(`Unsupported job type: ${job.type}`);
    } catch (error) {
      processingError = error;
    }
    const ownedJob = await heartbeat.stop();
    if (!ownedJob) {
      logger.error(
        { err: processingError, jobId: job.id, type: job.type, tenantId: job.tenantId },
        'job lease lost; another worker will recover it',
      );
      continue;
    }
    if (!processingError && recurringPayload) {
      try {
        await connectorScheduler.scheduleAfter(ownedJob, recurringPayload);
      } catch (error) {
        processingError = error;
      }
    }
    try {
      if (processingError) {
        await dependencies.queue.fail(ownedJob, processingError);
        logger.error(
          {
            err: processingError,
            jobId: job.id,
            type: job.type,
            tenantId: job.tenantId,
          },
          'job failed',
        );
      } else {
        await dependencies.queue.complete(ownedJob);
        logger.info({ jobId: job.id, type: job.type, tenantId: job.tenantId }, 'job completed');
      }
    } catch (error) {
      logger.error(
        { err: error, jobId: job.id, type: job.type, tenantId: job.tenantId },
        'job settlement failed; the lease will be recovered',
      );
    }
  }
  await dependencies.close();
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

import type { CredentialVault } from '../ports/credential-vault';
import type { JobQueue } from '../ports/job-queue';
import type { Job } from '../../domain/models';
import type { OAuthProvider } from '../../infrastructure/auth/provider-oauth-service';

export interface ConnectorSyncPayload {
  provider: OAuthProvider;
  userId: string;
  organizationId: string;
  scope?: string;
  recurring?: boolean;
}

export class ConnectorSyncScheduler {
  constructor(
    private readonly queue: JobQueue,
    private readonly credentialVault: CredentialVault,
    private readonly intervalSeconds: number,
    private readonly now: () => number = Date.now,
  ) {}

  async scheduleAfter(job: Job, payload: ConnectorSyncPayload): Promise<Job | undefined> {
    if (payload.recurring === false) return undefined;
    const stillConnected = await this.credentialVault.get(
      job.tenantId,
      payload.userId,
      payload.provider,
    );
    if (!stillConnected) return undefined;
    const intervalMs = this.intervalSeconds * 1000;
    const availableAtMs = this.now() + intervalMs;
    const scheduleSlot = Math.floor(availableAtMs / intervalMs);
    return this.queue.enqueue({
      tenantId: job.tenantId,
      type: 'connector.sync',
      idempotencyKey: `scheduled:${payload.provider}:${payload.userId}:${payload.organizationId}:${payload.scope ?? ''}:${scheduleSlot}`,
      payload: { ...payload, recurring: true },
      availableAt: new Date(availableAtMs).toISOString(),
    });
  }
}

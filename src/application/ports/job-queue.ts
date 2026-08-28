import type { Job } from '../../domain/models';

export interface EnqueueJob {
  tenantId: string;
  type: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  priority?: number;
  maxAttempts?: number;
  availableAt?: string;
}

export interface JobQueue {
  enqueue(input: EnqueueJob): Promise<Job>;
  leaseNext(workerId: string, leaseSeconds?: number): Promise<Job | undefined>;
  complete(job: Job): Promise<void>;
  fail(job: Job, error: unknown): Promise<void>;
  stats(tenantId: string): Promise<{
    queued: number;
    running: number;
    retryableFailed: number;
    deadLetter: number;
    oldestReadyAgeSeconds: number;
  }>;
  close(): Promise<void>;
}

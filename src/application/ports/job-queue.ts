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

export interface CancelPendingJobs {
  tenantId: string;
  type: string;
  payload: Record<string, string>;
}

export interface JobQueue {
  enqueue(input: EnqueueJob): Promise<Job>;
  cancelPending(input: CancelPendingJobs): Promise<number>;
  leaseNext(workerId: string, leaseSeconds?: number): Promise<Job | undefined>;
  renewLease(job: Job, leaseSeconds?: number): Promise<Job | undefined>;
  complete(job: Job): Promise<void>;
  fail(job: Job, error: unknown): Promise<void>;
  stats(tenantId: string): Promise<{
    queued: number;
    running: number;
    retryableFailed: number;
    deadLetter: number;
    cancelled: number;
    oldestReadyAgeSeconds: number;
  }>;
  close(): Promise<void>;
}

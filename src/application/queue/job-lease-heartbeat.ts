import type { JobQueue } from '../ports/job-queue';
import type { Job } from '../../domain/models';

export class JobLeaseHeartbeat {
  private current: Job;
  private timer?: NodeJS.Timeout;
  private renewal?: Promise<void>;
  private lost = false;

  constructor(
    private readonly queue: JobQueue,
    job: Job,
    private readonly leaseSeconds = 60,
    private readonly heartbeatMs = Math.max(1_000, Math.floor((leaseSeconds * 1_000) / 3)),
  ) {
    this.current = job;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.beginRenewal(), this.heartbeatMs);
    this.timer.unref();
  }

  async stop(): Promise<Job | undefined> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.renewal;
    if (this.lost || !this.current.leasedUntil) return undefined;
    const remainingMs = new Date(this.current.leasedUntil).getTime() - Date.now();
    if (remainingMs <= Math.min(5_000, (this.leaseSeconds * 1_000) / 3)) await this.renew();
    return this.lost ? undefined : this.current;
  }

  private beginRenewal(): void {
    if (this.renewal || this.lost) return;
    this.renewal = this.renew().finally(() => {
      this.renewal = undefined;
    });
  }

  private async renew(): Promise<void> {
    try {
      const renewed = await this.queue.renewLease(this.current, this.leaseSeconds);
      if (renewed) this.current = renewed;
      else this.lost = true;
    } catch {
      if (!this.current.leasedUntil || new Date(this.current.leasedUntil).getTime() <= Date.now())
        this.lost = true;
    }
  }
}

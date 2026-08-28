import type { HttpClient } from '../../domain/models';
import { boundedResponse, ResponseSizeLimitError } from './bounded-response';

export interface ProviderHttpOptions {
  allowedHosts: Set<string>;
  timeoutMs?: number;
  maxAttempts?: number;
  maxResponseBytes?: number;
  transport?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

export class ProviderHttpClient {
  private failures = 0;
  private circuitOpenUntil = 0;
  private readonly allowedHosts: Set<string>;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly maxResponseBytes: number;
  private readonly transport: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;

  constructor(options: ProviderHttpOptions) {
    this.allowedHosts = options.allowedHosts;
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.maxResponseBytes = options.maxResponseBytes ?? 6_000_000;
    this.transport = options.transport ?? fetch;
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? Date.now;
  }

  readonly fetch: HttpClient = async (input, init = {}) => {
    const url = new URL(input.toString());
    if (url.protocol !== 'https:' || !this.allowedHosts.has(url.hostname.toLowerCase()))
      throw new Error('Provider URL is not allowlisted');
    if (this.now() < this.circuitOpenUntil) throw new Error('Provider circuit is open');
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.transport(url, {
          ...init,
          redirect: 'error',
          signal: controller.signal,
        });
        if (response.status === 429 || response.status >= 500) {
          lastError = new Error(`Provider unavailable: ${response.status}`);
          await response.body?.cancel();
          if (attempt < this.maxAttempts) {
            await this.sleep(
              retryDelayMs(response.headers.get('retry-after'), attempt, this.now()),
            );
            continue;
          }
          throw lastError;
        }
        const bounded = await boundedResponse(response, this.maxResponseBytes, url.toString());
        this.failures = 0;
        return bounded;
      } catch (error) {
        lastError = error;
        if (error instanceof ResponseSizeLimitError) break;
        if (attempt < this.maxAttempts) {
          await this.sleep(Math.min(1_000, 100 * 2 ** (attempt - 1)));
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    this.failures += 1;
    if (this.failures >= 5) {
      this.circuitOpenUntil = this.now() + 30_000;
      this.failures = 0;
    }
    throw lastError instanceof Error ? lastError : new Error('Provider request failed');
  };
}

export function retryDelayMs(value: string | null, attempt: number, now = Date.now()): number {
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(5_000, seconds * 1_000);
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.min(5_000, Math.max(0, date - now));
  }
  return Math.min(5_000, 250 * 2 ** (attempt - 1));
}

import type { HttpClient } from '../../domain/models';

export class ProviderHttpClient {
  private failures = 0;
  private circuitOpenUntil = 0;
  constructor(
    private readonly allowedHosts: Set<string>,
    private readonly timeoutMs = 12_000,
    private readonly maxAttempts = 3,
  ) {}
  readonly fetch: HttpClient = async (input, init = {}) => {
    const url = new URL(input.toString());
    if (url.protocol !== 'https:' || !this.allowedHosts.has(url.hostname.toLowerCase()))
      throw new Error('Provider URL is not allowlisted');
    if (Date.now() < this.circuitOpenUntil) throw new Error('Provider circuit is open');
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(url, {
          ...init,
          redirect: 'error',
          signal: controller.signal,
        });
        if (response.status === 429 || response.status >= 500) {
          lastError = new Error(`Provider unavailable: ${response.status}`);
          if (attempt < this.maxAttempts) {
            const retryAfter = Math.min(5, Number(response.headers.get('retry-after') ?? 0));
            await new Promise((resolve) => setTimeout(resolve, (retryAfter || 2 ** attempt) * 100));
            continue;
          }
          throw lastError;
        }
        this.failures = 0;
        return response;
      } catch (error) {
        lastError = error;
        if (attempt < this.maxAttempts) continue;
      } finally {
        clearTimeout(timer);
      }
    }
    this.failures += 1;
    if (this.failures >= 5) {
      this.circuitOpenUntil = Date.now() + 30_000;
      this.failures = 0;
    }
    throw lastError instanceof Error ? lastError : new Error('Provider request failed');
  };
}

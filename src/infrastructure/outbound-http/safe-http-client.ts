import { Agent, fetch as undiciFetch } from 'undici';
import { resolvePublicHttpTarget } from '../../url';
import { boundedResponse } from './bounded-response';

export interface SafeHttpOptions {
  timeoutMs?: number;
  maxRedirects?: number;
  maxResponseBytes?: number;
  userAgent?: string;
  resolver?: typeof resolvePublicHttpTarget;
  transport?: typeof undiciFetch;
}
export class SafeHttpClient {
  private readonly timeoutMs: number;
  private readonly maxRedirects: number;
  private readonly maxResponseBytes: number;
  private readonly userAgent: string;
  private readonly resolver: typeof resolvePublicHttpTarget;
  private readonly transport: typeof undiciFetch;
  constructor(options: SafeHttpOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.maxRedirects = options.maxRedirects ?? 5;
    this.maxResponseBytes = options.maxResponseBytes ?? 2_000_000;
    this.userAgent = options.userAgent ?? 'RecruitingOS/0.2 (+campus recruiting aggregator)';
    this.resolver = options.resolver ?? resolvePublicHttpTarget;
    this.transport = options.transport ?? undiciFetch;
  }
  readonly fetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const method = (init.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD')
      throw new Error('Safe public fetch only supports GET and HEAD');
    let current = new URL(input.toString());
    for (let redirects = 0; redirects <= this.maxRedirects; redirects += 1) {
      const target = await this.resolver(current.toString());
      let nextAddress = 0;
      const agent = new Agent({
        connect: {
          lookup: (_hostname, _options, callback) => {
            const record = target.addresses[nextAddress % target.addresses.length];
            nextAddress += 1;
            if (!record) return callback(new Error('No validated public address'), ' ', 4);
            callback(null, record.address, record.family);
          },
        },
      });
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error('Outbound request timed out')),
        this.timeoutMs,
      );
      try {
        const headers: Record<string, string> = { 'user-agent': this.userAgent };
        new Headers(init.headers).forEach((value, key) => {
          headers[key] = value;
        });
        const response = await this.transport(current, {
          method,
          headers,
          signal: controller.signal,
          redirect: 'manual',
          dispatcher: agent,
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          if (!location) throw new Error('Redirect response is missing a location');
          if (redirects === this.maxRedirects) throw new Error('Too many redirects');
          current = new URL(location, current);
          continue;
        }
        return await boundedResponse(
          response as unknown as Response,
          this.maxResponseBytes,
          current.toString(),
        );
      } finally {
        clearTimeout(timer);
        await agent.close();
      }
    }
    throw new Error('Too many redirects');
  };
}

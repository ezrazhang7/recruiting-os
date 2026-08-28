const sanitizeLabel = (value: string) => value.replace(/[^a-zA-Z0-9_:]/g, '_');
const durationBucketsMs = [5, 10, 25, 50, 100, 250, 500, 750, 1_000, 1_500, 2_000, 5_000];

export class MetricsRegistry {
  private readonly requests = new Map<string, number>();
  private readonly durationMs = new Map<string, number>();
  private readonly durationBuckets = new Map<string, number[]>();

  observe(method: string, route: string, statusCode: number, elapsedMs: number): void {
    const normalizedRoute = route || 'unmatched';
    const key = `${sanitizeLabel(method)}|${sanitizeLabel(normalizedRoute)}|${statusCode}`;
    this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
    this.durationMs.set(key, (this.durationMs.get(key) ?? 0) + elapsedMs);
    const buckets = this.durationBuckets.get(key) ?? durationBucketsMs.map(() => 0);
    for (let index = 0; index < durationBucketsMs.length; index += 1)
      if (elapsedMs <= durationBucketsMs[index]!) buckets[index] = (buckets[index] ?? 0) + 1;
    this.durationBuckets.set(key, buckets);
  }

  render(): string {
    const lines = [
      '# HELP recruiting_os_http_requests_total Completed HTTP requests.',
      '# TYPE recruiting_os_http_requests_total counter',
    ];
    for (const [key, count] of this.requests) {
      const [method, route, status] = key.split('|');
      lines.push(
        `recruiting_os_http_requests_total{method="${method}",route="${route}",status="${status}"} ${count}`,
      );
    }
    lines.push(
      '# HELP recruiting_os_http_request_duration_ms Request duration in milliseconds.',
      '# TYPE recruiting_os_http_request_duration_ms histogram',
    );
    for (const [key, duration] of this.durationMs) {
      const [method, route, status] = key.split('|');
      const labels = `method="${method}",route="${route}",status="${status}"`;
      const buckets = this.durationBuckets.get(key) ?? durationBucketsMs.map(() => 0);
      for (let index = 0; index < durationBucketsMs.length; index += 1)
        lines.push(
          `recruiting_os_http_request_duration_ms_bucket{${labels},le="${durationBucketsMs[index]}"} ${buckets[index] ?? 0}`,
        );
      lines.push(
        `recruiting_os_http_request_duration_ms_bucket{${labels},le="+Inf"} ${this.requests.get(key) ?? 0}`,
        `recruiting_os_http_request_duration_ms_sum{${labels}} ${duration.toFixed(3)}`,
        `recruiting_os_http_request_duration_ms_count{${labels}} ${this.requests.get(key) ?? 0}`,
      );
    }
    return `${lines.join('\n')}\n`;
  }
}

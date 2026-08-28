const sanitizeLabel = (value: string) => value.replace(/[^a-zA-Z0-9_:]/g, '_');

export class MetricsRegistry {
  private readonly requests = new Map<string, number>();
  private readonly durationMs = new Map<string, number>();

  observe(method: string, route: string, statusCode: number, elapsedMs: number): void {
    const normalizedRoute = route || 'unmatched';
    const key = `${sanitizeLabel(method)}|${sanitizeLabel(normalizedRoute)}|${statusCode}`;
    this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
    this.durationMs.set(key, (this.durationMs.get(key) ?? 0) + elapsedMs);
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
      '# HELP recruiting_os_http_request_duration_ms_total Cumulative request duration.',
      '# TYPE recruiting_os_http_request_duration_ms_total counter',
    );
    for (const [key, duration] of this.durationMs) {
      const [method, route, status] = key.split('|');
      lines.push(
        `recruiting_os_http_request_duration_ms_total{method="${method}",route="${route}",status="${status}"} ${duration.toFixed(3)}`,
      );
    }
    return `${lines.join('\n')}\n`;
  }
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { MetricsRegistry } from '../src/infrastructure/observability/metrics';

test('HTTP latency metrics expose cumulative Prometheus histogram buckets', () => {
  const metrics = new MetricsRegistry();
  metrics.observe('GET', '/api/dashboard', 200, 7);
  metrics.observe('GET', '/api/dashboard', 200, 600);
  const rendered = metrics.render();

  assert.match(
    rendered,
    /recruiting_os_http_request_duration_ms_bucket\{method="GET",route="_api_dashboard",status="200",le="5"\} 0/,
  );
  assert.match(
    rendered,
    /recruiting_os_http_request_duration_ms_bucket\{method="GET",route="_api_dashboard",status="200",le="10"\} 1/,
  );
  assert.match(
    rendered,
    /recruiting_os_http_request_duration_ms_bucket\{method="GET",route="_api_dashboard",status="200",le="750"\} 2/,
  );
  assert.match(
    rendered,
    /recruiting_os_http_request_duration_ms_bucket\{method="GET",route="_api_dashboard",status="200",le="\+Inf"\} 2/,
  );
  assert.match(
    rendered,
    /recruiting_os_http_request_duration_ms_sum\{method="GET",route="_api_dashboard",status="200"\} 607\.000/,
  );
  assert.match(
    rendered,
    /recruiting_os_http_request_duration_ms_count\{method="GET",route="_api_dashboard",status="200"\} 2/,
  );
});

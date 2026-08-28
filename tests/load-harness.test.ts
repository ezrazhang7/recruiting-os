import assert from 'node:assert/strict';
import test from 'node:test';
import { metricValue, percentile } from '../scripts/load-test';

test('load harness parses labelled queue metrics exactly', () => {
  const metrics = `# TYPE recruiting_os_jobs gauge
recruiting_os_jobs{status="queued"} 7
recruiting_os_jobs{status="dead_letter"} 2
recruiting_os_oldest_ready_job_age_seconds 4.5
`;
  assert.equal(metricValue(metrics, 'recruiting_os_jobs', 'status="dead_letter"'), 2);
  assert.equal(metricValue(metrics, 'recruiting_os_oldest_ready_job_age_seconds'), 4.5);
  assert.equal(metricValue(metrics, 'missing_metric'), 0);
});

test('load harness percentile uses the nearest-rank definition', () => {
  assert.equal(percentile([5, 1, 4, 2, 3], 0.5), 3);
  assert.equal(percentile([5, 1, 4, 2, 3], 0.95), 5);
});

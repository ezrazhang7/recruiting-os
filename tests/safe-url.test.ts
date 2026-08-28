import assert from 'node:assert/strict';
import test from 'node:test';
import { opportunityDto } from '../src/http/public-dto';
import { ingestUrlSchema } from '../src/http/schemas/requests';

test('browser-facing and submitted URLs allow only credential-free HTTP(S)', () => {
  assert.throws(
    () => ingestUrlSchema.parse({ organizationId: 'club', url: 'javascript:alert(1)' }),
    /HTTP\(S\)/,
  );
  assert.throws(
    () => ingestUrlSchema.parse({ organizationId: 'club', url: 'https://user:secret@example.com' }),
    /HTTP\(S\)/,
  );
  const dto = opportunityDto({
    id: 'opportunity',
    organizationId: 'club',
    kind: 'application',
    title: 'Apply',
    url: 'javascript:alert(1)',
    confidence: 1,
    stale: false,
    sourceClaimIds: [],
    explanation: 'Unsafe extracted links are omitted.',
    resolvedAt: new Date(0).toISOString(),
  });
  assert.equal(dto.url, undefined);
});

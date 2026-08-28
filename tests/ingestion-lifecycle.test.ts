import assert from 'node:assert/strict';
import test from 'node:test';
import type { Extractor } from '../src/extractor';
import { fallbackExtractor } from '../src/extractor';
import { IngestionService } from '../src/ingest';
import { Store } from '../src/store';
import type { SourceItem } from '../src/types';

function source(organizationId: string, rawText: string): SourceItem {
  return {
    id: `input-${organizationId}`,
    organizationId,
    sourceType: 'website',
    externalId: 'website:https://club.example/apply',
    url: 'https://club.example/apply',
    rawText,
    media: [],
    fetchedAt: new Date().toISOString(),
  };
}

test('temporary extraction failures remain retryable and succeed on retry', async () => {
  const store = new Store();
  await store.upsertOrganization({ id: 'org', name: 'Club', school: 'UNC' });
  let attempts = 0;
  const extractor: Extractor = {
    extract: async (item) => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary provider failure');
      return fallbackExtractor.extract(item);
    },
  };
  const ingestion = new IngestionService(store, extractor);
  const item = source('org', 'Applications are now open!');

  await assert.rejects(() => ingestion.ingest(item, { followLinks: false }), /temporary/);
  const completed = await ingestion.ingest(item, { followLinks: false });

  assert.equal(attempts, 2);
  assert.equal(completed.processed, true);
  assert.equal((await store.getSourceVersionStatus(completed.versionId))?.status, 'succeeded');
  assert.equal((await store.listClaims('org')).length, 1);
  await store.close();
});

test('changed content at the same URL creates a new immutable version', async () => {
  const store = new Store();
  await store.upsertOrganization({ id: 'org', name: 'Club', school: 'UNC' });
  const ingestion = new IngestionService(store, fallbackExtractor);

  const first = await ingestion.ingest(source('org', 'Applications are closed.'), {
    followLinks: false,
  });
  const second = await ingestion.ingest(source('org', 'Applications are now open!'), {
    followLinks: false,
  });
  const unchanged = await ingestion.ingest(source('org', 'Applications are now open!'), {
    followLinks: false,
  });

  assert.notEqual(first.versionId, second.versionId);
  assert.equal(second.processed, true);
  assert.equal(unchanged.processed, false);
  assert.equal(unchanged.unchanged, true);
  assert.equal((await store.listClaims('org')).length, 3);
  await store.close();
});

test('source identity is scoped by organization', async () => {
  const store = new Store();
  await store.upsertOrganization({ id: 'org-a', name: 'Club A', school: 'UNC' });
  await store.upsertOrganization({ id: 'org-b', name: 'Club B', school: 'UNC' });
  const ingestion = new IngestionService(store, fallbackExtractor);

  const first = await ingestion.ingest(source('org-a', 'Applications are now open!'), {
    followLinks: false,
  });
  const second = await ingestion.ingest(source('org-b', 'Applications are now open!'), {
    followLinks: false,
  });

  assert.notEqual(first.versionId, second.versionId);
  assert.equal((await store.listClaims('org-a')).length, 1);
  assert.equal((await store.listClaims('org-b')).length, 1);
  await store.close();
});

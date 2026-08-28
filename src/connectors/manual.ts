import type { SourceItem } from '../types';
import { nowIso, stableId } from '../lib/util';
export function screenshotSource(
  orgId: string,
  input: { base64: string; mimeType?: string; note?: string; url?: string; publishedAt?: string },
): SourceItem {
  return {
    id: stableId('src', `screenshot:${orgId}:${input.base64.slice(0, 64)}:${input.note ?? ''}`),
    organizationId: orgId,
    sourceType: 'screenshot',
    url: input.url,
    title: 'Manual screenshot',
    rawText: input.note ?? '',
    media: [{ type: 'image', base64: input.base64, mimeType: input.mimeType ?? 'image/png' }],
    publishedAt: input.publishedAt,
    fetchedAt: nowIso(),
  };
}

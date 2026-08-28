import type { Claim, SourceItem } from './types';
import type { RecruitingRepository } from './application/ports/recruiting-repository';
import type { Extractor } from './extractor';
import { classifyUrl } from './url';
import { nowIso, stableId } from './lib/util';
import { resolveOrganization } from './resolver';
import { WebConnector } from './connectors/web';

export class IngestionService {
  constructor(
    private readonly store: RecruitingRepository,
    private readonly extractor: Extractor,
    private readonly web?: WebConnector,
  ) {}

  async ingest(
    source: SourceItem,
    { followLinks = true, maxDepth = 2 }: { followLinks?: boolean; maxDepth?: number } = {},
  ): Promise<{ versionId: string; processed: boolean; unchanged: boolean }> {
    const tenantId = source.tenantId;
    const staged = await this.store.stageSource(source, tenantId);
    if (!staged.shouldProcess) {
      return { versionId: staged.versionId, processed: false, unchanged: true };
    }

    const attempt = await this.store.markSourceProcessing(staged.versionId, tenantId);
    let result;
    try {
      result = await this.extractor.extract(source);
      const claims: Claim[] = result.claims.map((claim, index) => ({
        id: stableId(
          'clm',
          `${staged.versionId}:${index}:${claim.field}:${JSON.stringify(claim.value)}`,
        ),
        tenantId,
        organizationId: source.organizationId,
        sourceItemId: staged.versionId,
        field: claim.field,
        value: claim.value,
        confidence: claim.confidence,
        publishedAt: source.publishedAt,
        extractedAt: nowIso(),
        evidence: claim.evidence,
        temporalPrecision: claim.temporalPrecision,
      }));

      await this.store.transaction(async () => {
        await this.store.putClaims(claims, tenantId);
        await resolveOrganization(this.store, source.organizationId, new Date(), tenantId);
        await this.store.markSourceSucceeded(staged.versionId, tenantId);
      });
    } catch (error) {
      const delaySeconds = Math.min(900, 2 ** Math.min(attempt, 9));
      const nextAttemptAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
      await this.store.markSourceFailed(
        staged.versionId,
        {
          retryable: attempt < 5,
          message: error instanceof Error ? error.message : 'Unknown extraction failure',
          nextAttemptAt: attempt < 5 ? nextAttemptAt : undefined,
        },
        tenantId,
      );
      throw error;
    }

    if (followLinks && this.web && maxDepth > 0) {
      const candidates = [...new Set(result.discoveredUrls)].filter((url) =>
        ['application', 'bio_link', 'website'].includes(classifyUrl(url)),
      );
      for (const url of candidates.slice(0, 12)) {
        try {
          const { source: child, links } = await this.web.fetchSource(source.organizationId, url);
          child.tenantId = tenantId;
          await this.ingest(child, { followLinks: false });
          if (maxDepth > 1 && classifyUrl(url) === 'bio_link') {
            for (const next of links
              .filter((candidate) => ['application', 'website'].includes(classifyUrl(candidate)))
              .slice(0, 10)) {
              try {
                const fetched = await this.web.fetchSource(source.organizationId, next);
                fetched.source.tenantId = tenantId;
                await this.ingest(fetched.source, { followLinks: false });
              } catch {
                // Child failures are independently retryable and must not poison the parent.
              }
            }
          }
        } catch {
          // Child failures are independently retryable and must not poison the parent.
        }
      }
    }
    return { versionId: staged.versionId, processed: true, unchanged: false };
  }
}

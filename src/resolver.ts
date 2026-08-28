import type { Claim, Opportunity, SourceType } from './types';
import type { RecruitingRepository } from './application/ports/recruiting-repository';
import { nowIso, stableId } from './lib/util';

const authority: Record<SourceType, number> = {
  application: 1.0,
  groupme: 0.96,
  instagram: 0.94,
  gmail: 0.92,
  linkedin: 0.88,
  website: 0.78,
  bio_link: 0.75,
  screenshot: 0.72,
  heel_life: 0.55,
};

export const RESOLVER_VERSION = 'resolver-v2';

async function scoreClaim(
  c: Claim,
  store: RecruitingRepository,
  tenantId?: string,
): Promise<number> {
  const src = await store.getSource(c.sourceItemId, tenantId);
  const a = src ? authority[src.sourceType] : 0.5;
  const t = new Date(c.publishedAt ?? c.extractedAt).getTime();
  const ageDays = Math.max(0, (Date.now() - t) / 86400000);
  const recency = Math.max(0.55, 1 - Math.min(ageDays, 365) / 800);
  return c.confidence * a * recency;
}
function newest<T extends Claim>(xs: T[]): T | undefined {
  return xs
    .slice()
    .sort(
      (a, b) =>
        new Date(b.publishedAt ?? b.extractedAt).getTime() -
        new Date(a.publishedAt ?? a.extractedAt).getTime(),
    )[0];
}

export async function resolveOrganization(
  store: RecruitingRepository,
  orgId: string,
  now = new Date(),
  tenantId?: string,
): Promise<Opportunity[]> {
  const claims = await store.listClaims(orgId, tenantId);
  const scores = new Map<string, number>();
  await Promise.all(
    claims.map(async (claim) => scores.set(claim.id, await scoreClaim(claim, store, tenantId))),
  );
  const score = (claim: Claim | undefined) => (claim ? (scores.get(claim.id) ?? 0) : 0);
  const out: Opportunity[] = [];
  const deadlines = claims.filter((c) => c.field === 'application_deadline');
  const appUrls = claims.filter((c) => c.field === 'application_url');
  const openClaims = claims.filter((c) => c.field === 'application_open');
  const events = claims.filter((c) => c.field === 'event');
  const bestDeadline = deadlines.sort((a, b) => score(b) - score(a))[0];
  const bestUrl = appUrls.sort((a, b) => score(b) - score(a))[0];
  const latestOpen = newest(openClaims);

  if (bestDeadline || latestOpen) {
    const deadlineAt = bestDeadline ? String(bestDeadline.value) : undefined;
    const deadlineTime = deadlineAt ? new Date(deadlineAt).getTime() : NaN;
    const latestOpenTime = latestOpen
      ? new Date(latestOpen.publishedAt ?? latestOpen.extractedAt).getTime()
      : 0;
    const deadlineClaimTime = bestDeadline
      ? new Date(bestDeadline.publishedAt ?? bestDeadline.extractedAt).getTime()
      : 0;
    const explicitlyClosed = latestOpen?.value === false && latestOpenTime >= deadlineClaimTime;
    const reopened = latestOpen?.value === true && latestOpenTime > deadlineClaimTime;
    const stale =
      explicitlyClosed ||
      (!reopened && Number.isFinite(deadlineTime) && deadlineTime < now.getTime());
    out.push({
      id: stableId('opp', `${orgId}:application`),
      organizationId: orgId,
      kind: 'application',
      title: 'Application',
      deadlineAt: reopened ? undefined : deadlineAt,
      deadlinePrecision: reopened ? undefined : bestDeadline?.temporalPrecision,
      url: bestUrl ? String(bestUrl.value) : undefined,
      confidence: Math.max(score(bestDeadline), score(latestOpen)),
      stale,
      sourceClaimIds: [bestDeadline?.id, bestUrl?.id, latestOpen?.id].filter(Boolean) as string[],
      explanation: reopened
        ? 'A newer source says applications are open; older deadline suppressed until a current deadline is confirmed.'
        : explicitlyClosed
          ? 'The newest authoritative source says applications are closed.'
          : stale
            ? 'The best-supported deadline is in the past.'
            : 'Resolved from the highest-confidence application claims.',
      resolvedAt: nowIso(),
      resolverVersion: RESOLVER_VERSION,
    });
  }

  for (const c of events) {
    const v = c.value as any;
    if (!v || typeof v !== 'object') continue;
    out.push({
      id: stableId('opp', `${orgId}:event:${v.title}:${v.startsAt ?? ''}`),
      organizationId: orgId,
      kind: 'event',
      title: String(v.title ?? 'Recruiting event'),
      startsAt: v.startsAt,
      startsAtPrecision: v.startsAtPrecision,
      url: v.url,
      confidence: score(c),
      stale: v.startsAt ? new Date(v.startsAt).getTime() < now.getTime() : false,
      sourceClaimIds: [c.id],
      explanation: 'Event extracted from recruiting source.',
      resolvedAt: nowIso(),
      resolverVersion: RESOLVER_VERSION,
    });
  }
  const overrides = await store.listOpportunityOverrides(orgId, tenantId);
  for (const override of overrides) {
    const opportunity = out.find((candidate) => candidate.id === override.opportunityId);
    if (!opportunity) continue;
    Object.assign(opportunity, override.patch, {
      explanation: `${opportunity.explanation} Reviewed override: ${override.reason}`,
      resolverVersion: `${RESOLVER_VERSION}+review`,
    });
  }
  await store.replaceOpportunities(orgId, out, tenantId);
  return out;
}

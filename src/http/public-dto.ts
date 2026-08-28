import type { Organization, Opportunity } from '../domain/models';
import { safeHttpUrl } from '../lib/safe-url';

export function organizationDto(organization: Organization) {
  return {
    id: organization.id,
    name: organization.name,
    school: organization.school,
    websiteUrl: safeHttpUrl(organization.websiteUrl),
    heelLifeUrl: safeHttpUrl(organization.heelLifeUrl),
    instagramHandle: organization.instagramHandle,
    linkedinUrl: safeHttpUrl(organization.linkedinUrl),
  };
}
export function opportunityDto(opportunity: Opportunity) {
  return {
    id: opportunity.id,
    organizationId: opportunity.organizationId,
    kind: opportunity.kind,
    title: opportunity.title,
    deadlineAt: opportunity.deadlineAt,
    deadlinePrecision: opportunity.deadlinePrecision,
    startsAt: opportunity.startsAt,
    startsAtPrecision: opportunity.startsAtPrecision,
    url: safeHttpUrl(opportunity.url),
    role: opportunity.role,
    confidence: opportunity.confidence,
    stale: opportunity.stale,
    explanation: opportunity.explanation,
    resolvedAt: opportunity.resolvedAt,
  };
}

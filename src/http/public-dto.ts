import type { Organization, Opportunity } from '../domain/models';

export function organizationDto(organization:Organization){return{id:organization.id,name:organization.name,school:organization.school,websiteUrl:organization.websiteUrl,heelLifeUrl:organization.heelLifeUrl,instagramHandle:organization.instagramHandle,linkedinUrl:organization.linkedinUrl};}
export function opportunityDto(opportunity:Opportunity){return{id:opportunity.id,organizationId:opportunity.organizationId,kind:opportunity.kind,title:opportunity.title,deadlineAt:opportunity.deadlineAt,startsAt:opportunity.startsAt,url:opportunity.url,role:opportunity.role,confidence:opportunity.confidence,stale:opportunity.stale,explanation:opportunity.explanation,resolvedAt:opportunity.resolvedAt};}

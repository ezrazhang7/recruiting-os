import type { Organization } from '../types';
import { stableId } from '../lib/util';

export function organizationFromHeelLife(input: {
  name: string;
  heelLifeUrl: string;
  school?: string;
  websiteUrl?: string;
  instagramHandle?: string;
  linkedinUrl?: string;
}): Organization {
  return {
    id: stableId('org', input.heelLifeUrl),
    name: input.name,
    school: input.school ?? 'University of North Carolina at Chapel Hill',
    heelLifeUrl: input.heelLifeUrl,
    websiteUrl: input.websiteUrl,
    instagramHandle: input.instagramHandle,
    linkedinUrl: input.linkedinUrl,
  };
}

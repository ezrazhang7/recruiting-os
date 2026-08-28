import type { Role } from '../../domain/models';

export function initialRolesForIdentity(
  verifiedEmail: string | undefined,
  initialPlatformAdminEmails: readonly string[],
): Role[] {
  if (verifiedEmail && initialPlatformAdminEmails.includes(verifiedEmail.trim().toLowerCase())) {
    return ['platform_admin'];
  }
  return ['student'];
}

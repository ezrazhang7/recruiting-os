import { AuthorizationError } from '../../domain/errors';
import type { AuthPrincipal, Role } from '../../domain/models';

export function requireRole(principal:AuthPrincipal,roles:Role[]):void{
  if(!roles.some(role=>principal.roles.includes(role)))throw new AuthorizationError();
}
export function requireOrganizationAccess(principal:AuthPrincipal,organizationId:string):void{
  if(principal.roles.includes('platform_admin'))return;
  if(!principal.roles.includes('organization_editor')||!principal.organizationIds.includes(organizationId))throw new AuthorizationError();
}

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthRepository, OidcIdentity, SessionAuthentication } from '../ports/auth-repository';
import type { AuthPrincipal, Role } from '../../domain/models';
import { uid } from '../../lib/util';

export interface IssuedSession { token:string;csrfToken:string;expiresAt:string;principal:AuthPrincipal; }
export class SessionService {
  constructor(private readonly repository:AuthRepository,private readonly ttlSeconds:number){}
  async issue(identity:OidcIdentity,tenantId:string,defaultRoles:Role[]=['student']):Promise<IssuedSession>{
    const userId=await this.repository.upsertIdentity(identity,tenantId,defaultRoles);
    const token=randomBytes(32).toString('base64url');const csrfToken=randomBytes(32).toString('base64url');
    const id=uid('ses');const expiresAt=new Date(Date.now()+this.ttlSeconds*1000).toISOString();
    await this.repository.createSession({id,tenantId,userId,tokenHash:hashSecret(token),csrfHash:hashSecret(csrfToken),expiresAt});
    const authenticated=await this.repository.authenticateSession(hashSecret(token));if(!authenticated)throw new Error('Created session could not be loaded');
    return{token,csrfToken,expiresAt,principal:authenticated.principal};
  }
  async authenticate(token:string|undefined):Promise<SessionAuthentication|undefined>{return token?this.repository.authenticateSession(hashSecret(token)):undefined;}
  verifyCsrf(authentication:SessionAuthentication,provided:string|undefined):boolean{
    if(!provided)return false;const actual=Buffer.from(hashSecret(provided));const expected=Buffer.from(authentication.csrfHash);return actual.length===expected.length&&timingSafeEqual(actual,expected);
  }
  async revoke(principal:AuthPrincipal):Promise<void>{await this.repository.revokeSession(principal.sessionId,principal.tenantId);}
}
export function hashSecret(value:string):string{return createHash('sha256').update(value).digest('hex');}

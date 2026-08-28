export interface StoredCredential {
  id:string;tenantId:string;userId:string;provider:string;encryptedPayload:Buffer;
  keyVersion:string;scopes:string[];expiresAt?:string;revokedAt?:string;
}
export interface CredentialRepository {
  save(credential:StoredCredential):Promise<void>;
  find(tenantId:string,userId:string,provider:string):Promise<StoredCredential|undefined>;
  revoke(tenantId:string,userId:string,provider:string):Promise<void>;
  close():Promise<void>;
}

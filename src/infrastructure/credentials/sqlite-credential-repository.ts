import type { CredentialRepository, StoredCredential } from '../../application/ports/credential-repository';
import { nowIso } from '../../lib/util';
import type { Store } from '../../store';

export class SqliteCredentialRepository implements CredentialRepository {
  constructor(private readonly store:Store){}
  async save(value:StoredCredential):Promise<void>{const now=nowIso();this.store.db.prepare(`insert into credentials(id,tenant_id,user_id,provider,encrypted_payload,key_version,scopes,expires_at,created_at,updated_at)
    values(?,?,?,?,?,?,?,?,?,?) on conflict(tenant_id,user_id,provider) do update set encrypted_payload=excluded.encrypted_payload,key_version=excluded.key_version,scopes=excluded.scopes,expires_at=excluded.expires_at,revoked_at=null,updated_at=excluded.updated_at`).run(value.id,value.tenantId,value.userId,value.provider,value.encryptedPayload,value.keyVersion,JSON.stringify(value.scopes),value.expiresAt??null,now,now);}
  async find(tenantId:string,userId:string,provider:string):Promise<StoredCredential|undefined>{const row=this.store.db.prepare('select * from credentials where tenant_id=? and user_id=? and provider=?').get(tenantId,userId,provider) as Record<string,unknown>|undefined;return row?{id:String(row.id),tenantId:String(row.tenant_id),userId:String(row.user_id),provider:String(row.provider),encryptedPayload:Buffer.from(row.encrypted_payload as Uint8Array),keyVersion:String(row.key_version),scopes:JSON.parse(String(row.scopes)) as string[],expiresAt:row.expires_at?String(row.expires_at):undefined,revokedAt:row.revoked_at?String(row.revoked_at):undefined}:undefined;}
  async revoke(tenantId:string,userId:string,provider:string):Promise<void>{this.store.db.prepare('update credentials set revoked_at=?,updated_at=? where tenant_id=? and user_id=? and provider=?').run(nowIso(),nowIso(),tenantId,userId,provider);}
  async close():Promise<void>{}
}

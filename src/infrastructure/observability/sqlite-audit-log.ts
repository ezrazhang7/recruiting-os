import type { AuditEvent, AuditLog } from '../../application/ports/audit-log';
import { nowIso, uid } from '../../lib/util';
import type { Store } from '../../store';
export class SqliteAuditLog implements AuditLog {constructor(private readonly store:Store){}async write(event:AuditEvent):Promise<void>{this.store.db.prepare(`insert into audit_events(id,tenant_id,actor_id,action,resource_type,resource_id,request_id,metadata,created_at) values(?,?,?,?,?,?,?,?,?)`).run(uid('aud'),event.tenantId,event.actorId??null,event.action,event.resourceType,event.resourceId??null,event.requestId??null,JSON.stringify(event.metadata??{}),nowIso());}async close():Promise<void>{}}

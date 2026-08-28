export interface AuditEvent {
  tenantId: string;
  actorId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
}
export interface AuditLog {
  write(event: AuditEvent): Promise<void>;
  close(): Promise<void>;
}

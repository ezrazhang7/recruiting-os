begin;
drop schema if exists app cascade;
drop table if exists audit_events, tenant_queue_state, jobs, sessions, credentials, connector_state,
  opportunities, claims, source_versions, sources, organizations, memberships, users, tenants cascade;
commit;

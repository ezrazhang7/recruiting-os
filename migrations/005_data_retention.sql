create function app.run_maintenance()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  tenant record;
  affected integer;
  private_versions integer := 0;
  private_claims integer := 0;
  failed_jobs integer := 0;
  expired_sessions integer := 0;
  revoked_credentials integer := 0;
  expired_audit_events integer := 0;
  expired_rate_buckets integer := 0;
begin
  for tenant in select id from tenants loop
    perform set_config('app.tenant_id', tenant.id, true);

    update source_versions sv
      set raw_text='', media='[]'::jsonb,
          metadata=jsonb_build_object('retentionRedacted', true, 'redactedAt', now())
      from sources s
      where sv.source_id=s.id and sv.tenant_id=tenant.id and s.tenant_id=tenant.id
        and s.source_type in ('gmail','groupme','screenshot')
        and sv.fetched_at < now() - interval '90 days'
        and not (sv.metadata ? 'retentionRedacted');
    get diagnostics affected = row_count;
    private_versions := private_versions + affected;

    update claims c set evidence=null
      from source_versions sv, sources s
      where c.source_version_id=sv.id and sv.source_id=s.id
        and c.tenant_id=tenant.id and sv.tenant_id=tenant.id and s.tenant_id=tenant.id
        and s.source_type in ('gmail','groupme','screenshot')
        and sv.fetched_at < now() - interval '90 days'
        and c.evidence is not null;
    get diagnostics affected = row_count;
    private_claims := private_claims + affected;

    update jobs set payload=jsonb_build_object('retentionRedacted', true), updated_at=now()
      where tenant_id=tenant.id and status in ('dead_letter','cancelled')
        and updated_at < now() - interval '30 days'
        and not (payload ? 'retentionRedacted');
    get diagnostics affected = row_count;
    failed_jobs := failed_jobs + affected;

    delete from sessions where tenant_id=tenant.id and expires_at < now();
    get diagnostics affected = row_count;
    expired_sessions := expired_sessions + affected;

    delete from credentials where tenant_id=tenant.id and revoked_at is not null
      and revoked_at < now() - interval '30 days';
    get diagnostics affected = row_count;
    revoked_credentials := revoked_credentials + affected;

    delete from audit_events where tenant_id=tenant.id
      and created_at < now() - interval '365 days';
    get diagnostics affected = row_count;
    expired_audit_events := expired_audit_events + affected;
  end loop;

  delete from rate_limit_buckets where expires_at < now();
  get diagnostics expired_rate_buckets = row_count;

  return jsonb_build_object(
    'privateSourceVersions', private_versions,
    'privateClaimEvidence', private_claims,
    'failedJobPayloads', failed_jobs,
    'expiredSessions', expired_sessions,
    'revokedCredentials', revoked_credentials,
    'expiredAuditEvents', expired_audit_events,
    'expiredRateBuckets', expired_rate_buckets
  );
end
$$;
revoke all on function app.run_maintenance() from public;
grant execute on function app.run_maintenance() to public;

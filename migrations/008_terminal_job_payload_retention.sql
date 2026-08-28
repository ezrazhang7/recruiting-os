create or replace function app.lease_job(worker text, lease_seconds integer default 60)
returns setof jobs
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if lease_seconds < 5 or lease_seconds > 3600 then
    raise exception 'invalid job lease duration';
  end if;

  update jobs set status='dead_letter',leased_by=null,leased_until=null,
    last_error='Worker lease expired after final attempt',
    payload=case when type='ingest.screenshot' then jsonb_build_object(
      'retentionRedacted',true,'redactedAt',now(),'reason','terminal-screenshot-job'
    ) else payload end,
    updated_at=now()
  where status='running' and leased_until < now() and attempt_count >= max_attempts;

  return query
  with ranked as (
    select j.id,
      row_number() over(partition by j.tenant_id order by j.priority, j.created_at) as tenant_rank
    from jobs j
    where (
      j.status in ('queued','retryable_failed') and j.available_at <= now()
      and (j.leased_until is null or j.leased_until < now())
    ) or (
      j.status='running' and j.leased_until < now() and j.attempt_count < j.max_attempts
    )
  ), candidate as (
    select j.id,j.tenant_id from jobs j join ranked r on r.id=j.id
    left join tenant_queue_state t on t.tenant_id=j.tenant_id
    where r.tenant_rank=1
    order by coalesce(t.last_leased_at,'epoch'),j.priority,j.created_at
    limit 1 for update of j skip locked
  ), leased as (
    update jobs j set status='running',attempt_count=j.attempt_count+1,
      leased_by=worker,
      leased_until=date_trunc('milliseconds',clock_timestamp())+make_interval(secs=>lease_seconds),
      updated_at=now()
    from candidate c where j.id=c.id returning j.*
  ), touched as (
    insert into tenant_queue_state(tenant_id,last_leased_at)
    select tenant_id,now() from candidate
    on conflict(tenant_id) do update set last_leased_at=excluded.last_leased_at
    returning tenant_id
  )
  select leased.* from leased cross join touched;
end $$;

create or replace function app.finish_job(
  candidate_job_id text,
  expected_lease timestamptz,
  candidate_worker text,
  failure text default null
)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare current_job jobs%rowtype;
begin
  select * into current_job from jobs where jobs.id=candidate_job_id for update;
  if current_job.id is null or current_job.status <> 'running'
    or current_job.leased_by is distinct from candidate_worker
    or current_job.leased_until is distinct from expected_lease
    or current_job.leased_until <= now() then
    raise exception 'job lease is no longer valid';
  end if;
  if failure is null then
    update jobs set status='succeeded',leased_by=null,leased_until=null,last_error=null,
      payload=case when type='ingest.screenshot' then jsonb_build_object(
        'retentionRedacted',true,'redactedAt',now(),'reason','terminal-screenshot-job'
      ) else payload end,
      updated_at=now()
    where id=candidate_job_id;
  elsif current_job.attempt_count >= current_job.max_attempts then
    update jobs set status='dead_letter',leased_by=null,leased_until=null,
      last_error=left(failure,500),
      payload=case when type='ingest.screenshot' then jsonb_build_object(
        'retentionRedacted',true,'redactedAt',now(),'reason','terminal-screenshot-job'
      ) else payload end,
      updated_at=now()
    where id=candidate_job_id;
  else
    update jobs set status='retryable_failed',
      available_at=now()+make_interval(secs=>least(900,power(2,least(current_job.attempt_count,9))::int)),
      leased_by=null,leased_until=null,last_error=left(failure,500),updated_at=now()
    where id=candidate_job_id;
  end if;
end $$;

create or replace function app.run_maintenance()
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
  terminal_jobs integer := 0;
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

    update jobs set payload=jsonb_build_object(
      'retentionRedacted',true,'redactedAt',now(),'reason','terminal-job-retention'
    ), updated_at=now()
      where tenant_id=tenant.id and status in ('succeeded','dead_letter','cancelled')
        and updated_at < now() - interval '30 days'
        and not (payload ? 'retentionRedacted');
    get diagnostics affected = row_count;
    terminal_jobs := terminal_jobs + affected;

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
    'terminalJobPayloads', terminal_jobs,
    'failedJobPayloads', terminal_jobs,
    'expiredSessions', expired_sessions,
    'revokedCredentials', revoked_credentials,
    'expiredAuditEvents', expired_audit_events,
    'expiredRateBuckets', expired_rate_buckets
  );
end
$$;

revoke all on function app.lease_job(text,integer) from public;
revoke all on function app.finish_job(text,timestamptz,text,text) from public;
revoke all on function app.run_maintenance() from public;
grant execute on function app.lease_job(text,integer) to public;
grant execute on function app.finish_job(text,timestamptz,text,text) to public;
grant execute on function app.run_maintenance() to public;

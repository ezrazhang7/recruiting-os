create or replace function app.lease_job(worker text, lease_seconds integer default 60)
returns setof jobs
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if lease_seconds < 5 or lease_seconds > 3600 then
    raise exception 'invalid job lease duration';
  end if;

  update jobs set status='dead_letter',leased_by=null,leased_until=null,
    last_error='Worker lease expired after final attempt',updated_at=now()
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

create function app.renew_job_lease(
  candidate_job_id text,
  expected_lease timestamptz,
  candidate_worker text,
  lease_seconds integer default 60
)
returns timestamptz
language plpgsql security definer set search_path = public, pg_temp as $$
declare renewed_until timestamptz;
begin
  if lease_seconds < 5 or lease_seconds > 3600 then
    raise exception 'invalid job lease duration';
  end if;
  update jobs set
    leased_until=date_trunc('milliseconds',clock_timestamp())+make_interval(secs=>lease_seconds),
    updated_at=now()
  where id=candidate_job_id and status='running' and leased_by=candidate_worker
    and leased_until=expected_lease and leased_until>now()
  returning leased_until into renewed_until;
  return renewed_until;
end $$;

create function app.finish_job(
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
    update jobs set status='succeeded',leased_by=null,leased_until=null,last_error=null,updated_at=now()
    where id=candidate_job_id;
  elsif current_job.attempt_count >= current_job.max_attempts then
    update jobs set status='dead_letter',leased_by=null,leased_until=null,
      last_error=left(failure,500),updated_at=now()
    where id=candidate_job_id;
  else
    update jobs set status='retryable_failed',
      available_at=now()+make_interval(secs=>least(900,power(2,least(current_job.attempt_count,9))::int)),
      leased_by=null,leased_until=null,last_error=left(failure,500),updated_at=now()
    where id=candidate_job_id;
  end if;
end $$;

revoke all on function app.lease_job(text,integer) from public;
revoke all on function app.renew_job_lease(text,timestamptz,text,integer) from public;
revoke all on function app.finish_job(text,timestamptz,text,text) from public;
grant execute on function app.lease_job(text,integer) to public;
grant execute on function app.renew_job_lease(text,timestamptz,text,integer) to public;
grant execute on function app.finish_job(text,timestamptz,text,text) to public;

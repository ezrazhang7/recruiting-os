drop function app.finish_job(text,timestamptz,text,text);
drop function app.renew_job_lease(text,timestamptz,text,integer);

create or replace function app.lease_job(worker text, lease_seconds integer default 60)
returns setof jobs
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query
  with ranked as (
    select j.id,
      row_number() over(partition by j.tenant_id order by j.priority, j.created_at) as tenant_rank
    from jobs j
    where j.status in ('queued','retryable_failed')
      and j.available_at <= now()
      and (j.leased_until is null or j.leased_until < now())
  ), candidate as (
    select j.id,j.tenant_id from jobs j join ranked r on r.id=j.id
    left join tenant_queue_state t on t.tenant_id=j.tenant_id
    where r.tenant_rank=1
    order by coalesce(t.last_leased_at,'epoch'),j.priority,j.created_at
    limit 1 for update of j skip locked
  ), leased as (
    update jobs j set status='running',attempt_count=j.attempt_count+1,
      leased_by=worker,leased_until=now()+make_interval(secs=>lease_seconds),updated_at=now()
    from candidate c where j.id=c.id returning j.*
  ), touched as (
    insert into tenant_queue_state(tenant_id,last_leased_at)
    select tenant_id,now() from candidate
    on conflict(tenant_id) do update set last_leased_at=excluded.last_leased_at
    returning tenant_id
  )
  select leased.* from leased cross join touched;
end $$;

grant execute on function app.lease_job(text,integer) to public;

create table rate_limit_buckets (
  key_hash text not null,
  window_start timestamptz not null,
  request_count integer not null default 0 check (request_count >= 0),
  expires_at timestamptz not null,
  primary key (key_hash, window_start)
);
create index rate_limit_buckets_expiry on rate_limit_buckets(expires_at);

create function app.consume_rate_limit(
  candidate_key_hash text,
  candidate_limit integer,
  candidate_window_ms integer
)
returns table(allowed boolean, remaining integer, reset_at_ms bigint)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  current_window timestamptz;
  current_count integer;
  current_reset timestamptz;
begin
  if candidate_limit < 1 or candidate_window_ms < 1000 then
    raise exception 'invalid rate limit configuration';
  end if;
  current_window := to_timestamp(
    floor(extract(epoch from clock_timestamp()) * 1000 / candidate_window_ms)
      * candidate_window_ms / 1000
  );
  current_reset := current_window + make_interval(secs => candidate_window_ms::double precision / 1000);
  insert into rate_limit_buckets(key_hash, window_start, request_count, expires_at)
  values(candidate_key_hash, current_window, 1, current_reset + interval '1 minute')
  on conflict(key_hash, window_start) do update
    set request_count = rate_limit_buckets.request_count + 1
  returning request_count into current_count;
  return query select
    current_count <= candidate_limit,
    greatest(0, candidate_limit - current_count),
    floor(extract(epoch from current_reset) * 1000)::bigint;
end $$;
revoke all on function app.consume_rate_limit(text,integer,integer) from public;
grant execute on function app.consume_rate_limit(text,integer,integer) to public;

create table resolver_policies (
  version text primary key,
  description text not null,
  policy jsonb not null,
  created_at timestamptz not null default now()
);
insert into resolver_policies(version, description, policy) values(
  'resolver-v2',
  'Evidence authority, recency, explicit closure, and stale deadline policy',
  '{"timezone":"America/New_York","date_only_deadline_time":"23:59","authority_order":["application","groupme","instagram","gmail","linkedin","website","bio_link","screenshot","heel_life"]}'
) on conflict(version) do nothing;

create table opportunity_overrides (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  opportunity_id text not null,
  organization_id text not null,
  actor_id text not null references users(id) on delete restrict,
  patch jsonb not null,
  reason text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  foreign key (tenant_id, organization_id) references organizations(tenant_id, id) on delete cascade
);
create index opportunity_overrides_active
  on opportunity_overrides(tenant_id, opportunity_id, created_at desc)
  where revoked_at is null;
alter table opportunity_overrides enable row level security;
alter table opportunity_overrides force row level security;
create policy tenant_isolation on opportunity_overrides
  using (tenant_id = app.current_tenant_id())
  with check (tenant_id = app.current_tenant_id());

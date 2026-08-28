create extension if not exists pgcrypto;

create table tenants (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now()
);

create table users (
  id text primary key,
  issuer text not null,
  subject text not null,
  email text,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (issuer, subject)
);

create table memberships (
  tenant_id text not null references tenants(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  roles text[] not null default array['student']::text[],
  organization_ids text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id),
  check (roles <@ array['student','organization_editor','platform_admin']::text[])
);

create table organizations (
  tenant_id text not null references tenants(id) on delete cascade,
  id text not null,
  name text not null,
  school text not null,
  heel_life_url text,
  website_url text,
  instagram_handle text,
  linkedin_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);

create table sources (
  id text primary key,
  tenant_id text not null,
  organization_id text not null,
  source_type text not null,
  identity_key text not null,
  external_id text,
  url text,
  title text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  foreign key (tenant_id, organization_id) references organizations(tenant_id, id) on delete cascade,
  unique (tenant_id, organization_id, source_type, identity_key)
);

create table source_versions (
  id text primary key,
  source_id text not null references sources(id) on delete cascade,
  tenant_id text not null references tenants(id) on delete cascade,
  organization_id text not null,
  content_hash text not null,
  raw_text text not null,
  media jsonb not null default '[]',
  published_at timestamptz,
  fetched_at timestamptz not null,
  metadata jsonb not null default '{}',
  status text not null check(status in ('received','queued','processing','succeeded','retryable_failed','terminal_failed')),
  attempt_count integer not null default 0 check(attempt_count >= 0),
  next_attempt_at timestamptz,
  last_error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (source_id, content_hash),
  foreign key (tenant_id, organization_id) references organizations(tenant_id, id) on delete cascade
);
create index source_versions_ready on source_versions(status, next_attempt_at, created_at);
create index source_versions_org on source_versions(tenant_id, organization_id, fetched_at desc);

create table claims (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  organization_id text not null,
  source_version_id text not null references source_versions(id) on delete cascade,
  field text not null,
  value jsonb not null,
  confidence double precision not null check(confidence between 0 and 1),
  published_at timestamptz,
  extracted_at timestamptz not null default now(),
  supersedes jsonb not null default '[]',
  evidence text,
  unique(source_version_id, field, value),
  foreign key (tenant_id, organization_id) references organizations(tenant_id, id) on delete cascade
);
create index claims_org_field on claims(tenant_id, organization_id, field, published_at desc);

create table opportunities (
  id text not null,
  tenant_id text not null,
  organization_id text not null,
  kind text not null check(kind in ('application','event','task')),
  title text not null,
  deadline_at timestamptz,
  starts_at timestamptz,
  url text,
  role text,
  confidence double precision not null check(confidence between 0 and 1),
  stale boolean not null default false,
  source_claim_ids jsonb not null,
  explanation text not null,
  resolver_version text not null,
  resolved_at timestamptz not null default now(),
  primary key (tenant_id, id),
  foreign key (tenant_id, organization_id) references organizations(tenant_id, id) on delete cascade
);
create index opportunities_org on opportunities(tenant_id, organization_id, deadline_at, starts_at);

create table connector_state (
  tenant_id text not null references tenants(id) on delete cascade,
  connector text not null,
  scope text not null,
  cursor text,
  metadata jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (tenant_id, connector, scope)
);

create table credentials (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  provider text not null,
  encrypted_payload bytea not null,
  key_version text not null,
  scopes text[] not null default '{}',
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, user_id, provider)
);

create table sessions (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  token_hash text not null unique,
  csrf_hash text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index sessions_expiry on sessions(expires_at) where revoked_at is null;

create table jobs (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  type text not null,
  idempotency_key text not null,
  payload jsonb not null,
  status text not null check(status in ('queued','running','succeeded','retryable_failed','dead_letter')),
  priority integer not null default 100,
  attempt_count integer not null default 0,
  max_attempts integer not null default 5,
  available_at timestamptz not null default now(),
  leased_until timestamptz,
  leased_by text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, type, idempotency_key)
);
create index jobs_ready on jobs(status, available_at, priority, created_at);

create table tenant_queue_state (
  tenant_id text primary key references tenants(id) on delete cascade,
  last_leased_at timestamptz
);

create table audit_events (
  id text primary key,
  tenant_id text not null references tenants(id) on delete cascade,
  actor_id text references users(id) on delete set null,
  action text not null,
  resource_type text not null,
  resource_id text,
  request_id text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index audit_events_tenant_time on audit_events(tenant_id, created_at desc);

create schema if not exists app;
create function app.current_tenant_id() returns text
language sql stable as $$ select nullif(current_setting('app.tenant_id', true), '') $$;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'memberships','organizations','sources','source_versions','claims','opportunities',
    'connector_state','credentials','sessions','jobs','tenant_queue_state','audit_events'
  ] loop
    execute format('alter table %I enable row level security', table_name);
    execute format('alter table %I force row level security', table_name);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = app.current_tenant_id()) with check (tenant_id = app.current_tenant_id())',
      table_name
    );
  end loop;
end $$;

create function app.authenticate_session(candidate_hash text)
returns table(session_id text, tenant_id text, user_id text, csrf_hash text, expires_at timestamptz)
language sql security definer set search_path = public, pg_temp as $$
  select s.id, s.tenant_id, s.user_id, s.csrf_hash, s.expires_at
  from sessions s
  where s.token_hash = candidate_hash and s.revoked_at is null and s.expires_at > now()
  limit 1
$$;
revoke all on function app.authenticate_session(text) from public;
grant execute on function app.authenticate_session(text) to public;

create function app.lease_job(worker text, lease_seconds integer default 60)
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

create function app.finish_job(candidate_job_id text, expected_lease timestamptz, failure text default null)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare current_job jobs%rowtype;
begin
  select * into current_job from jobs where jobs.id=candidate_job_id for update;
  if current_job.id is null or current_job.leased_until is distinct from expected_lease then
    raise exception 'job lease is no longer valid';
  end if;
  if failure is null then
    update jobs set status='succeeded',leased_by=null,leased_until=null,last_error=null,updated_at=now()
    where id=candidate_job_id;
  elsif current_job.attempt_count >= current_job.max_attempts then
    update jobs set status='dead_letter',leased_by=null,leased_until=null,last_error=left(failure,500),updated_at=now()
    where id=candidate_job_id;
  else
    update jobs set status='retryable_failed',available_at=now()+make_interval(secs=>least(900,power(2,least(current_job.attempt_count,9))::int)),
      leased_by=null,leased_until=null,last_error=left(failure,500),updated_at=now()
    where id=candidate_job_id;
  end if;
end $$;
grant execute on function app.lease_job(text,integer) to public;
grant execute on function app.finish_job(text,timestamptz,text) to public;

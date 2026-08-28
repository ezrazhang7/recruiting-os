alter table source_versions add constraint source_versions_tenant_id_id_key
  unique (tenant_id, id);

alter table connector_state add column owner_user_id text;
alter table connector_state add constraint connector_state_owner_membership_fkey
  foreign key (tenant_id, owner_user_id)
  references memberships(tenant_id, user_id) on delete cascade;

alter table users add column membership_count integer not null default 0
  check (membership_count >= 0);
do $$
declare tenant record;
begin
  for tenant in select id from tenants loop
    perform set_config('app.tenant_id', tenant.id, true);
    update users u set membership_count=membership_count+counts.total
      from (
        select user_id,count(*)::integer as total
        from memberships where tenant_id=tenant.id group by user_id
      ) counts
      where u.id=counts.user_id;
    -- Legacy cursor keys were shared between users. Discard them so each account performs a
    -- bounded, independently keyed resynchronization after this migration.
    delete from connector_state
      where tenant_id=tenant.id and connector in ('gmail', 'groupme');
  end loop;
end $$;

create function app.adjust_user_membership_count()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp as $$
begin
  if tg_op='INSERT' then
    update users set membership_count=membership_count+1 where id=new.user_id;
    return new;
  end if;
  update users set membership_count=membership_count-1 where id=old.user_id;
  return old;
end $$;
create trigger memberships_adjust_user_count
after insert or delete on memberships
for each row execute function app.adjust_user_membership_count();
revoke all on function app.adjust_user_membership_count() from public;

create table source_version_contributors (
  tenant_id text not null references tenants(id) on delete cascade,
  source_version_id text not null,
  user_id text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, source_version_id, user_id),
  foreign key (tenant_id, source_version_id)
    references source_versions(tenant_id, id) on delete cascade,
  foreign key (tenant_id, user_id)
    references memberships(tenant_id, user_id) on delete cascade
);
create index source_version_contributors_user
  on source_version_contributors(tenant_id, user_id, created_at desc);

alter table source_version_contributors enable row level security;
alter table source_version_contributors force row level security;
create policy tenant_isolation on source_version_contributors
  using (tenant_id = app.current_tenant_id())
  with check (tenant_id = app.current_tenant_id());

alter table opportunity_overrides drop constraint opportunity_overrides_actor_id_fkey;
alter table opportunity_overrides alter column actor_id drop not null;
alter table opportunity_overrides add constraint opportunity_overrides_actor_id_fkey
  foreign key (actor_id) references users(id) on delete set null;

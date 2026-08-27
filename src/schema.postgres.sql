-- Production-oriented Postgres/Supabase equivalent of the local SQLite store.
create table organizations (
  id text primary key, name text not null, school text not null,
  heel_life_url text, website_url text, instagram_handle text, linkedin_url text,
  created_at timestamptz not null default now()
);
create table source_items (
  id text primary key, organization_id text not null references organizations(id) on delete cascade,
  source_type text not null, external_id text, url text, title text, raw_text text not null,
  media jsonb not null default '[]', published_at timestamptz, fetched_at timestamptz not null default now(), metadata jsonb not null default '{}'
);
create unique index source_external_unique on source_items(source_type, external_id) where external_id is not null;
create table claims (
  id text primary key, organization_id text not null references organizations(id) on delete cascade,
  source_item_id text not null references source_items(id) on delete cascade,
  field text not null, value jsonb not null, confidence double precision not null check (confidence between 0 and 1),
  published_at timestamptz, extracted_at timestamptz not null default now(), supersedes jsonb not null default '[]', evidence text
);
create index claims_org_field on claims(organization_id, field, published_at desc);
create table opportunities (
  id text primary key, organization_id text not null references organizations(id) on delete cascade,
  kind text not null, title text not null, deadline_at timestamptz, starts_at timestamptz, url text, role text,
  confidence double precision not null, stale boolean not null default false, source_claim_ids jsonb not null, explanation text not null,
  resolved_at timestamptz not null default now()
);

-- Cross-tenant security-definer functions (session lookup, fair leasing, and maintenance) must be
-- owned by a dedicated migration role that can see every row. Runtime connections must use a
-- separate non-owner role; startup verifies that contract. RLS remains enabled for runtime SQL.
do $$
declare table_name text;
begin
  foreach table_name in array array[
    'memberships','organizations','sources','source_versions','source_version_contributors',
    'claims','opportunities','opportunity_overrides','connector_state','credentials','sessions',
    'jobs','tenant_queue_state','audit_events'
  ] loop
    execute format('alter table %I no force row level security', table_name);
  end loop;
end $$;

begin;
drop table if exists opportunity_overrides;
drop table if exists resolver_policies;
drop function if exists app.consume_rate_limit(text,integer,integer);
drop table if exists rate_limit_buckets;
commit;

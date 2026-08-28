alter table claims add column temporal_precision text
  check(temporal_precision in ('date','date_time','relative_inferred'));
alter table opportunities add column deadline_precision text
  check(deadline_precision in ('date','date_time','relative_inferred'));
alter table opportunities add column starts_at_precision text
  check(starts_at_precision in ('date','date_time','relative_inferred'));

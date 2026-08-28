begin;
alter table opportunities drop column if exists starts_at_precision;
alter table opportunities drop column if exists deadline_precision;
alter table claims drop column if exists temporal_precision;
commit;

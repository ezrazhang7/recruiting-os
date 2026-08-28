alter table jobs drop constraint jobs_status_check;
alter table jobs add constraint jobs_status_check
  check(status in ('queued','running','succeeded','retryable_failed','dead_letter','cancelled'));


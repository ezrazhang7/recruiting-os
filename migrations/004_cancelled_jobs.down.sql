update jobs set status='dead_letter', last_error=coalesce(last_error, 'Cancelled')
where status='cancelled';
alter table jobs drop constraint jobs_status_check;
alter table jobs add constraint jobs_status_check
  check(status in ('queued','running','succeeded','retryable_failed','dead_letter'));


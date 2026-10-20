# Student sync worker cutover

Prepared 20 October 2026, Australia/Brisbane. This is an opt-in deployment;
no production migration, cloud provisioning or schedule activation was performed.
The Australian hosting move belongs to Sophia Runtime P7-01/P7-02, after this
performance work. Do not move the Sydney database to Singapore. AWS Australia
is an assessment option, not an approved deployment or spend commitment.

## Execution contract

- Invoice API requests only enqueue when `XERO_SYNC_EXECUTION_MODE=worker`.
  Signed webhooks enqueue too; they do not call Xero in the request process.
- The dedicated invoice worker polls every 15 seconds, serially, with a separate
  pool capped at two connections. It claims manual work any time, automatic
  work only between 01:00 inclusive and 06:00 exclusive Brisbane time. Existing
  leases/checkpoints handle restart recovery; an in-progress import may finish
  after 06:00. A successful import schedules the next automatic import at 01:00
  the next day, not hourly. Failed automatic imports retain backoff and retry
  only in an automatic window. Explicit manual refresh can run during the day.
- A queued webhook is upgraded to a full import when reconciliation is due,
  so continuous webhooks cannot starve periodic reconciliation.
- The identity worker independently processes manual Check records / Sync ready
  users. Changed import watermarks trigger previews, including after a daytime
  manual import. Automatic account creation starts only overnight, still using
  the existing eligible Chief Executive reauthorization. No permission is
  granted by scheduling. Ambiguous/unlinked invoices remain Pending action;
  exclusions and reviewed mappings remain authoritative.
- A successful preview/apply commits its source watermark checkpoint with the
  identity/link changes. Document discovery requires a checkpoint at least as
  recent as that connection's last successful import, an enabled connection and
  tenant, and no queued/processing invoice import. A failed or missing checkpoint
  holds documents; it does not mark them complete. Runtime has SELECT-only
  checkpoint access with tenant RLS.
- The existing document cron remains one bounded run at 03:00 Brisbane, max 500
  sources / 30 minutes, with provider backoff. A late/failed upstream stage may
  defer work until the next invocation. `waiting_or_backoff` is not completion.
  Do not add catch-up invocations or increase throughput without the shared
  provider-budget work in phase 4. This change does not claim a global rate limiter.

## Safe deployment order

1. Back up configuration and verify the existing Runtime migrations and identity
   sync tables. Apply Runtime **080_student_sync_worker_pipeline.sql** through
   the normal owner migration process, and apply
   **scripts/sql/bm_xero_student_worker_pipeline.sql** as the identity owner.
   Neither script changes existing Student IDs, invoices or case dates.
2. Deploy Runtime and Business Manager code with current execution modes unchanged
   (`inline` / unset). Confirm ordinary list requests and manual jobs still work.
3. Prepare the two worker definitions after approving hosting cost, but do not
   start them until step 4. Applying the optional blueprint starts workers. The
   `render.student-sync-workers.yaml` is separate from the existing blueprint
   to prevent accidental creation. Use existing scoped secrets, never put them
   in Git. The invoice worker uses the Runtime app-role connection; the identity
   worker uses the existing identity service's connection and reauthorization,
   not a new permission-bypassing Runtime role. Copy any non-default schema/TLS
   configuration as well. These workers do not start HTTP/email/inspection loops.
4. Transfer ownership during a maintenance window with no active import/apply
   job. Disable `XERO_SYNC_SCHEDULER_ENABLED` on every Runtime API replica; set
   `XERO_SYNC_EXECUTION_MODE=worker` there and on the invoice worker. Set
   `STUDENT_USER_SYNC_EXECUTION_MODE=worker` on every BM API replica and its new
   worker. Stop old processes before provisioning/starting the replacement workers; leases
   are a safety net, not a reason to leave duplicate schedulers enabled.
5. Set `STUDENT_SYNC_PIPELINE_ENABLED=true` on the identity and document workers.
   Keep the current single document cron. Missing migrations fail closed; do
   not bypass dependencies to make a cron look successful.
6. Verify a manual request returns promptly and produces one durable run. Observe
   its completion, the downstream preview checkpoint, unchanged invoice counts,
   latest-invoice advisors, unresolved invoice visibility and explicit exclusions.
   No live test sync is authorized merely by this checklist.
7. Observe one actual night: invoice success -> preview/apply checkpoint -> document
   progress. Check missed runs, oldest queue age, safe error classifications and
   Retry-After. Alert through the hosting monitor on worker errors/missed nights.
   Keep timing temporarily enabled; collect at least 20 authenticated samples
   per page and compare idle/active sync p50/p95. Do not add nested timing values.

## Rollback and outstanding gates

Stop new workers before restoring legacy API execution. Leave additive tables,
checkpoints and committed records intact. Legacy automatic invoice scheduling is
hourly; rollback restores that behavior, not the new nightly policy. Reconcile
ownership before restarting jobs. Never clear leases, queues, mappings or
documents simply to remove a warning.

Production rollout, restart recovery, hosting alert delivery and measured p95
remain operator verification gates. Phase 4 still needs verified Xero app tier,
shared cross-process quota accounting, source deduplication/fan-out and changed
source rechecks before historical discovery is accelerated. Australian migration
assessment remains a separate later Runtime workstream.

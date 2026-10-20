# Student sync: single-worker cutover

Updated 20 October 2026, Australia/Brisbane. This supersedes the earlier
two-worker instructions. One shared worker executes invoices, student
reconciliation and document discovery; do not create the separate invoice/user
services. Keep the email cron unchanged. Australian hosting assessment remains
Sophia Runtime P7-01/P7-02; do not relocate the Sydney database to Singapore.

## Current release checkpoint

The user confirmed Runtime migration 080 and the identity pipeline columns were
applied. Both APIs were deployed in enqueue-only mode. The existing document
cron remains the document executor until deliberately suspended. No shared worker
has been provisioned or started by this implementation. Invoice and student jobs
can remain queued until the shared worker starts; list pages use stored data.

## What the single worker does

- Runs `node scripts/process-student-sync.mjs` in one container, not an API and
  not `weeklyGenerator.js`. It starts no HTTP, media, inspection or email loops.
- Uses a Runtime application-role pool and a separate identity-service pool,
  each capped at two connections. Never substitute the migration owner URL for
  the Runtime URL or bypass `sophia_runtime_app`/tenant RLS.
- Sequentially polls invoices, then student reconciliation every ~15 seconds.
  Importing an invoice register can delay later stages until that import finishes.
  Browser requests only enqueue; they do not wait for these stages to finish.
- Invoice scheduling/claims preserve migration 080: automatic work starts only
  01:00–06:00 Brisbane; explicit manual jobs may run any time. Signed webhooks
  queue automatic work. Successful imports schedule the next automatic night.
- Identity scheduling reuses eligible Chief Executive reauthorization and the
  existing bounded scan/apply transactions. Source changes trigger previews even
  after a daytime manual import. Automatic account creation is overnight;
  manually requested Check records / Sync ready users remains available all day.
- Documents start only 03:00–06:00 Brisbane, after committed connection-specific
  reconciliation checkpoints and with no queued/processing invoice import.
  Applying students invalidates the earlier preview checkpoint until apply
  finishes. Explicit exclusions/unresolved records are not silently accepted.
- Documents are serial, paced at least two seconds apart, for the explicit
  customer IDs configured on the worker. Invoice/identity queues retain their
  existing multi-tenant eligibility rules; the document allowlist does not scope
  those queues. Do not add document tenants without reviewing authorization and
  provider capacity for them.
- New Runtime migration **081_shared_student_worker_document_budget.sql** makes
  the 500-source-attempt limit and 30-minute window durable per customer/Brisbane
  date. Claims reserve budget in the same transaction as the job lease. No ready
  source means no budget timer starts. Crashes/redeploys cannot reset the budget.
- Any document provider failure blocks further discovery until at least the next
  document night and the supplied bounded Retry-After. That block survives
  restarts and date rollover. Per-source retry state is retained. This source
  budget is NOT a global API-call quota shared with imports or downloads.
- An idle/dependency-blocked document queue is checked about once a minute;
  invoices/users still get priority. A five-minute `student_sync_heartbeat` log
  shows process liveness, not successful data synchronization. Errors are logged
  without raw payloads, names, URLs or credentials. Runtime/user job tables remain
  the source for completion/failure status.

## Deployment: take one step at a time

1. Deploy the updated Runtime code. Through the normal owner migration process,
   apply **081** once. Do not reapply 080 or the identity script already confirmed
   by the user. Migration 081 adds a budget table/helper; it does not modify
   existing students, invoice amounts, dates, mappings or discovered files.
2. Keep both APIs enqueue-only:
   - Runtime: `XERO_SYNC_EXECUTION_MODE=worker`, `XERO_SYNC_SCHEDULER_ENABLED=false`.
   - BM API: `STUDENT_USER_SYNC_EXECUTION_MODE=worker`.
   - Neither API needs `STUDENT_SYNC_PIPELINE_ENABLED` for this cutover.
   Confirm the latest deployment is live on all replicas and pages still load.
3. Prepare ONE Render Background Worker using the same backend repo/branch,
   repository root as build context (no `sophia-runtime` root directory),
   Dockerfile **Dockerfile.student-sync**, and Docker Command
   **node scripts/process-student-sync.mjs**. One instance only. The optional
   `render.student-sync-workers.yaml` now defines only this service. Applying it
   creates paid compute and starts execution; do not apply prematurely.
4. Set the worker's non-secret controls:

   ```text
   XERO_SYNC_EXECUTION_MODE=worker
   XERO_SYNC_SCHEDULER_ENABLED=false
   STUDENT_USER_SYNC_EXECUTION_MODE=worker
   STUDENT_SYNC_PIPELINE_ENABLED=true
   SOPHIA_RUNTIME_DB_POOL_SIZE=2
   DB_POOL_SIZE=2
   DB_SSL=true
   STUDENT_SYNC_DOCUMENT_CUSTOMER_IDS=<customer UUID from the old document cron>
   ```

   For multiple reviewed document customers, use comma-separated UUIDs.
   Copy `SOPHIA_RUNTIME_DATABASE_URL` and existing Xero client/secret, redirect,
   return URL, OAuth state secret and token-encryption key from Runtime.
   Copy `DATABASE_URL` from Business Manager. Preserve any non-default schema,
   Runtime TLS and role settings. Do not regenerate encryption keys. Never paste
   connection strings or secret screenshots into chat. The worker image builds
   both dependency trees; it does not copy local `.env` or `node_modules`.
5. Before starting the worker, verify no old invoice/user worker is active.
   Suspend **sophia-case-document-discovery** and wait for any in-progress run to
   finish (or for its existing lease to expire after a platform interruption).
   Queued documents are normal; do not delete jobs or reset leases. Do not run
   old cron discovery alongside the shared worker: the old cron does not reserve
   the new daily budget. Keep **sophia-ai-toolkit-email-cron** unchanged.
6. Start the shared worker only after reviewing cost and the configuration.
   Expect `student_sync_worker_ready`, followed by periodic heartbeats. It fails
   startup if execution flags, document customer IDs or migrations are missing.
   No live provider test is authorized merely by this checklist. Once the user
   requests a manual sync, observe a promptly queued request, one durable run,
   its final status and the subsequent identity checkpoint.
7. Observe one actual night: invoice completion -> identity reconciliation ->
   document progress, with daily budget counts <=500. Check Pending action and
   explicit exclusions, provider errors, queue age and last successful jobs.
   Set hosting alerts for worker errors/restarts/missed nights. Collect comparable
   authenticated idle/active-sync timing samples; screenshots are not p95.
8. After successful observation, keep the old document cron suspended for rollback.
   Retiring it is a separate deliberate action. `render.yaml` is a legacy rollback
   definition; do not reapply it and accidentally reactivate document processing.

## Rollback and remaining work

Stop the shared worker before restoring any legacy execution. To restore legacy
invoice/user processing, restore API execution modes and the prior scheduler
setting, understanding that legacy automatic invoices are hourly. Resume the old
document cron only after the shared worker has stopped; do not run both. Preserve
additive schemas, daily budgets, queues, mappings and committed business data.

Phase 4 still needs verified Xero app allowance, shared API quota accounting,
document source deduplication/fan-out and changed-source rechecks. No throughput
increase or claim that a whole backlog is finished is made here. Container build,
production startup, hosting alert delivery, overnight recovery and p95 are
deployment verification gates. No provisioning, production migration or provider
call was executed during local implementation.

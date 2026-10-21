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

Phase 4 release status is recorded below: Starter allowance is confirmed, source
deduplication deployment is user-confirmed, and daily admission is ready locally.
Changed-source rechecks, alerts and measured throughput remain open. No throughput
increase or claim that a whole backlog is finished is made here. Container build,
production startup, hosting alert delivery, overnight recovery and p95 are
deployment verification gates. No provisioning, production migration or provider
call was executed during local implementation.

## Queued webhook follow-up — 21 October 2026

Operator evidence confirms the shared worker is Live/ready and the old document
cron is suspended. Startup readiness alone does not prove successful syncs.
The first manual identity apply failed in scan because an invoice webhook queued
for tonight was incorrectly interpreted as an import in progress.

The follow-up fix uses the same automatic-window policy as Runtime: processing
imports always block (including expired leases awaiting recovery), queued manual
imports block, and queued automatic imports block only in the automatic window.
Both automatic identity scheduling and each processing batch use this policy.
Blocking dependencies leave the same job queued/processing for a later poll;
they do not mark it failed or publish a reconciliation checkpoint.

Release this fix by deploying **nodejs-api** and **sophia-student-sync-worker**
from the same revision. No additional SQL migration or environment variable is
required. Keep the document cron suspended and both APIs enqueue-only.
Click **Check records** once, then verify that the new run is `preview` and
`succeeded`. Keep the historical failed `apply` row as audit history; do not
reset it or automatically retry account creation. No provider refresh is needed
for this check. Successful overnight processing, document backlog progress and
the shared provider-rate-budget follow-up still require validation. Australian
hosting migration remains deferred to the Runtime P7 assessment.

## Phase 4A: shared Xero cooldown (user-confirmed deployed)

User subsequently confirmed migration 082 and both flags; daily exhaustion was
observed in SQL. Historical release procedure, retained for recovery:

1. Deploy Runtime API and shared-worker code with `XERO_SHARED_BACKOFF_ENABLED`
   absent or `false`. Business Manager API and frontend do not change.
2. Apply additive Runtime migration `082_xero_connection_rate_limits.sql` using
   the existing owner migration runner (`npm run migrate` in the Runtime image).
   Do not replace the normal application's database URL with owner credentials.
3. Set `XERO_SHARED_BACKOFF_ENABLED=true` on **sophia-runtime-api** and
   **sophia-student-sync-worker**, deploying each configuration. It is not needed
   on **nodejs-api**. Do not activate just one consumer and call the rollout done.
4. Confirm worker readiness and observe existing/normally scheduled operations;
   do not force provider requests or deliberately exhaust quota as a test.
   Check the cooldown/allowance metadata with the read-only query below.
5. Keep the document cron suspended and the 500-source/30-minute cap unchanged.
   Successful overnight observation is still required. Rollback this slice by
   setting the flag `false` on both consumers, retaining the additive table and
   queue/history. This restores previous backoff behavior, not a throughput gain.

```sql
SELECT xero_connection_id, day_remaining, minute_remaining,
       app_minute_remaining, limit_problem, observed_at, blocked_until,
       blocked_until > now() AS cooling_down
FROM sophia_runtime.xero_connection_rate_limits
WHERE customer_id = '33ed40a6-7f2b-407c-aab2-de76b1cb45a8';
```

Rows appear only after a provider response contains allowance headers or a 429;
no row is not proof of available quota. Use the configured Runtime schema if
different. The store shares cooldown across imports, document discovery/downloads,
candidate discovery and connection tests for the same customer/connection. Known
document cooldowns do not consume another source attempt. Network calls run
outside database transactions, and tenant/role permission checks remain intact.

This is **not** an API reservation ledger, cross-tenant app-minute limiter, or
deduplicated source cache. Requests already in flight can overlap; another
connection identity for the same provider organisation is not automatically
merged. OAuth/token/bootstrap calls before a persisted connection exists are
outside this Accounting policy. Header snapshots can change or arrive out of
order and are not spendable balances; only the cooldown is monotonically extended.
Valid numeric `Retry-After` values are honored up to a defensive seven-day bound.
Missing/invalid 429 delay defaults to a day, or 60 seconds for a known minute/app/
concurrent limit. Successful daily exhaustion uses a conservative 24-hour hold;
it does not assume Xero resets at Brisbane midnight. Normal workers still obey
their existing overnight windows.

Subsequent releases below cover source deduplication and daily reservation
accounting. App-wide limits, changed-source rechecks and operator alerts remain
open. See [Xero's rate-limit documentation](https://developer.xero.com/documentation/best-practices/api-call-efficiencies/rate-limits/)
for remaining headers, `X-Rate-Limit-Problem` and `Retry-After`. Do not infer the
account's actual quota from an old fixed daily-limit assumption.

## Payments queued-state UI follow-up — 21 October 2026

Operator evidence now shows student sync succeeded (1120 processed, zero users
created), migration 082 applied, and shared backoff enabled on both consumers.
The portal confirms Starter plan; the response-observation query still returns
no rows, so the remaining allowance is unknown. Neither student success nor
flags alone prove provider activity or successful overnight discovery.

Payments treated a queued webhook as active, disabling Refresh and polling it
until timeout. The frontend-only fix separates queued automatic jobs from manual
or processing jobs: scheduled work shows the Brisbane overnight window without
continuous polling, while Refresh remains available to explicitly promote it.
Check progress on a manual/processing job performs only a status GET; it does not
enqueue another provider import. Active progress polling remains bounded and
skips hidden tabs. Existing records remain visible throughout.

Deploy/reload the frontend only for this fix. No SQL, flag changes, worker restart
or deletion/reset of the webhook row is required. Verify the scheduled text and
enabled Refresh without clicking it solely to test quota. A deliberate Refresh
does consume provider allowance once processed, so leave the job overnight unless
there is a genuine business need for a daytime import.

## Phase 4B: source discovery deduplication (deployment user-confirmed)

This release does not change the automatic windows, pacing, 500-source cap or
30-minute provider-fetch budget. It preserves existing per-case jobs/documents.
Migration 083 adds a source lease/cache keyed by customer, connection, source
kind and source UUID, plus an explicit-refresh timestamp on case jobs. There is
no migration backfill, queue reset, or provider call. In particular, old completed
jobs are not assumed to be proof of a complete/current attachment list.

One provider discovery can supply metadata to up to 25 currently invoice-linked
case jobs per local transaction. Further cases reuse the committed result on
subsequent passes for at most 24 hours. Empty results are cached too. Updated
source metadata is replayed to already-completed linked jobs in bounded passes.
Links, active connection/tenant, import state and reconciliation checkpoints are
rechecked before publication. Case reads/downloads retain their existing role
checks; downloads are not cached or made public.

Only new provider fetch attempts reserve the existing source budget. Cached
metadata can still be associated locally when cooldown/cap prevents more calls.
The 24-hour TTL is a reuse limit, not an automatic recheck schedule or deletion
policy. Normalized metadata is bounded to 1000 attachments per source; no file
contents, credentials, provider URLs or response bodies are cached. Removed files
are not automatically deleted from existing case metadata by this release.

Step-by-step release (not executed by the agent):

1. Deploy Runtime API and shared-worker code with
   `STUDENT_DOCUMENT_SOURCE_DEDUP_ENABLED` absent/`false` on both.
2. Apply Runtime migration `083_student_document_source_cache.sql` via the owner
   migration runner. In the shared-worker shell, the compiled runner is
   `node /app/sophia-runtime/dist/database/migrate.js`; use an owner connection
   only for that command, not as the saved application connection.
3. Enable `STUDENT_DOCUMENT_SOURCE_DEDUP_ENABLED=true` on **sophia-runtime-api**
   first, then **sophia-student-sync-worker**. The API marks explicit discovery
   requests as requiring a fresh lookup; the worker owns processing. All API
   replicas must agree. Keep `XERO_SHARED_BACKOFF_ENABLED=true` on both.
4. Check shared-worker readiness; it requires migration 083 and shared backoff.
   Keep the old document cron suspended. No Business Manager API/frontend change
   is needed. Do not request discovery solely to consume quota for a smoke test.
5. Observe normal overnight progress, source versus case-job counts, provider
   errors, quota headers and document access controls. Do not claim a savings
   percentage until measured. A source attempt can include multiple HTTP retries
   and is not an API-call reservation.

Read-only baseline for queued case sources (not a guaranteed call-count forecast):

```sql
SELECT count(*) AS queued_case_sources,
       count(DISTINCT (xero_connection_id, source_kind, source_id)) AS unique_sources
FROM sophia_runtime.student_operations_document_jobs
WHERE customer_id = '33ed40a6-7f2b-407c-aab2-de76b1cb45a8'
  AND status = 'queued';
```

After activation, inspect bounded source-state summaries without filenames:

```sql
SELECT status, count(*) AS sources,
       count(*) FILTER (WHERE checked_at IS NOT NULL) AS previously_discovered,
       count(*) FILTER (WHERE lease_expires_at > now()) AS live_leases
FROM sophia_runtime.student_operations_document_sources
WHERE customer_id = '33ed40a6-7f2b-407c-aab2-de76b1cb45a8'
GROUP BY status;
```

Rollback: stop the shared worker and let its source/case leases drain or expire
before restoring the legacy document path. Set the new flag false on both
consumers, then restart the same worker; do not resume the old cron alongside it.
Retain migration 083, source/case jobs, mappings, budgets and committed metadata.
Disabling deduplication restores per-case provider calls and may consume more
quota. If canonical sources remain processing after rollback, do not re-enable
until those leases have expired. Daily admission/headroom is the separate Phase
4C release below. Automatic changed-source/rechecks, clear quota/reset UI,
alerts and production validation remain separate tasks.

## Phase 4C: shared daily admission and protected headroom (local, disabled)

User reports migration 083 applied and shared worker Live at `8aedd7c`.
That is deployment evidence, not proof of overnight document throughput.

Migration 084 adds a connection-scoped daily admission ledger. Owner-configured
defaults match the confirmed Starter allowance: **1000 calls, 200 protected from
attachment discovery**. Imports, connection tests and authorized content downloads
can use the reserve, and can still exhaust it. It is not an extra 200 calls.
Every managed Accounting HTTP attempt, including retries, takes one atomic
credit before fetch. Ambiguous/sent attempts are not refunded. Durable counters
and response tickets prevent concurrent or delayed responses from restoring
already-spent credit. Cached metadata fan-out needs no provider credit.

Unknown balances pause discovery. At most one ordinary operational request per
60 seconds may establish headers; no synthetic quota request is generated.
Provider daily `Retry-After` anchors the next reset and its fixed 24-hour cadence.
Without that hint, a conservative local 24-hour refresh bound is used; it is not
a claimed provider reset time. Expiry returns the balance to unknown, not 1000.
Never clear a cooldown or force a provider request to make this release look green.
Existing published cooldowns are not shortened by this feature.

Release one step at a time (not executed by agent):

1. Deploy **sophia-runtime-api** and **sophia-student-sync-worker** with
   `XERO_SHARED_QUOTA_ENABLED` absent/`false`. Let active work finish before
   restarting the worker. No Business Manager API/frontend deployment is needed.
2. Apply `084_xero_quota_admission.sql` using the existing owner migration runner.
   Shared-worker compiled runner: `node /app/sophia-runtime/dist/database/migrate.js`.
   Use the owner connection only for that command; keep saved application
   connections on the non-BYPASSRLS Runtime role. Do not delete/rewrite queues.
3. Confirm `XERO_SHARED_BACKOFF_ENABLED=true` and
   `STUDENT_DOCUMENT_SOURCE_DEDUP_ENABLED=true` on both services. Then set
   `XERO_SHARED_QUOTA_ENABLED=true` on both and redeploy. All Runtime replicas
   must agree. Startup fails closed if the worker prerequisites are missing.
4. Check worker readiness and observe ordinary scheduled work. Keep the old
   document cron suspended, enqueue-only APIs and existing windows/caps/pacing.
   A missing/unknown ledger balance before ordinary work is expected, not proof
   of remaining quota. Do not force a Refresh solely for validation.
5. Inspect state read-only and compare normal discovery progress to its earlier
   baseline before deciding whether to change hours, reserve or source cap.

```sql
SELECT xero_connection_id, daily_limit, discovery_reserve, remaining,
       generation_admissions, operational_admissions, discovery_admissions,
       refresh_after, provider_reset_at, observed_at,
       CASE WHEN remaining IS NULL OR refresh_after <= now() THEN NULL
            ELSE greatest(0, remaining-discovery_reserve) END AS discovery_credit
FROM sophia_runtime.xero_quota_admission
WHERE customer_id = '33ed40a6-7f2b-407c-aab2-de76b1cb45a8';
```

Admission counters are cumulative; `generation_admissions` is the current local
epoch, not a provider billing report. `remaining` is a conservative managed credit
estimate and can be stale. `refresh_after` is a local re-observation boundary;
`provider_reset_at` is the last daily retry hint, not a guarantee of availability.
Allowance/reserve configuration is owner-only; do not raise 1000 merely because
a larger tier exists. A paid upgrade needs separate confirmed entitlement.

Limits: this is per persisted connection, not an app-wide minute/concurrency
reservation or organisation merge across different connection identities.
OAuth/bootstrap before persisted connections and unmanaged consumers remain
outside this ledger. Conservative accounting can leave some capacity unused.
Automatic changed-source/rechecks, quota-specific UI, alerts, overnight success,
measured savings and p95 are still open. Do not expand the schedule in this cutover.

Rollback: stop the worker, let leases drain, disable only
`XERO_SHARED_QUOTA_ENABLED` on both consumers, then restart the same worker.
Keep migrations, counters, source deduplication and shared backoff. Disabling
quota admission removes headroom protection; it does not increase provider quota
or authorize bypassing an existing cooldown. Never resume the old cron alongside it.

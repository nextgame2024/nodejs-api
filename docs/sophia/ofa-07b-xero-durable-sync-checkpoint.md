# OFA-07B checkpoint — durable Xero student read model

Date: 10 October 2026  
Decision: implemented in source; deployment, migration 067, scheduler/webhook configuration and live TRUST proof remain pending

## Outcome

The Students screen no longer requires Xero consent or a provider request during ordinary use. Xero contacts and
sales invoices synchronize into tenant-isolated PostgreSQL projections. Search and infinite loading query those
projections, manual Refresh creates a durable run, and the last successful data remains available if Xero fails.

The first successful run is a full import. Later runs use `If-Modified-Since` with overlap, hourly scheduling and a
12-hour reconciliation cycle. Signed Xero contact/invoice webhooks coalesce into the same queue. Database leases,
one-active-run uniqueness and retry scheduling make the worker safe across concurrent runtime instances and process
restarts. Rate limits and provider correlation IDs are recorded without exposing tokens or provider bodies.

Candidates remain review-only. Creating a student from a candidate records the explicit Xero-contact link so it is
not offered repeatedly. The integration is read-only and does not infer colleges, advisors, stages or legal identity.

## Deployment/configuration gate

1. Deploy the backend source, then run `npm run migrate` once with a migration-capable database role.
2. Configure `XERO_SYNC_SCHEDULER_ENABLED=true` on at least one runtime instance.
3. Set `XERO_WEBHOOK_KEY` and register
   `https://sophia-runtime-api.onrender.com/api/connectors/xero/v1/webhooks` in the Xero application.
4. Deploy the frontend, open Students as Chief Executive and select **Refresh** once for the initial TRUST import.
5. Verify freshness, counts and a reviewed candidate against the connected TRUST organisation before enabling PTY.

No production migration, deployment, Xero request or live customer-data operation was performed in this source
checkpoint.

## Evidence

- `npm run typecheck`: passed.
- Focused Xero/read-model backend suite: 6 suites, 17 tests passed.
- Sophia Runtime full suite: 158 suites, 568 tests passed.
- Sophia Runtime production build and portability-core typecheck: passed.
- Focused Angular Student Operations suite: 28 tests passed in Chrome Headless.
- Angular application TypeScript check and production build: passed. Existing bundle/font/CommonJS/PrimeIcons
  warnings remain unchanged.
- Protected real-estate regression: 8 suites, 38 tests passed.
- Sophia boundary scan: passed across 271 new-product source files.

# Student-agency quarantine and trust map

## Current coupling

Student-agency code is currently active in shared product paths:

- Express registers `bm.studentAgency.routes.js` in `src/app.js`.
- Models, services, source verification, cards, schema bootstraps, consultation booking, email delivery, and workers use the `bm.student*` files and `bm_student_*` tables.
- `server.js` and `cron/weeklyGenerator.js` start student consultation schema/workers alongside real-estate work.
- Nest registers student knowledge and consultation tools under `sophia-runtime/src/tools/student-agency`; `knowledge/sophia-profile.ts` contains cross-domain routing instructions.
- Angular's kiosk imports student guidance and consultation components and switches panels/tool outputs in `frontend/src/app/sophia-runtime`.

P0 does not remove any of these files, routes, tables, records, or workers. Future v2 roots are checked to reject student imports while delivery/disposition is decided separately.

## P1 quarantine state

- The active Nest tool catalogue and Sophia profile no longer import or register student tools.
- The active real-estate Business Manager client contains only real-estate endpoints. The retained student transport is located under `sophia-runtime/src/tools/student-agency` and has no import path from the active module graph.
- Direct calls to deprecated student tool IDs are rejected by the active registry.
- The Angular kiosk no longer imports student components, renders student panels, or handles student tool outputs.
- Express student routes, schema bootstraps, records and workers are preserved as legacy code. A read-only check on 23 September 2026 found nine consultation deliveries, all `sent`, with no outstanding delivery state.

## Preserve while quarantining

- Keep existing real-estate inspection startup, report and email workers working.
- Keep generic database, email-provider, and worker primitives; do not copy student-specific semantics into core.
- Preserve student tables/data until a separately approved export/archive/delete plan exists.
- Do not make student tools available to new v2 agents, catalogs, release manifests, or Admin bindings.
- Do not use student fallback knowledge as a generic retrieval implementation.

## Authority and mutation boundaries

| Boundary | Observed authority | Trust concern |
|---|---|---|
| Browser to Nest runtime | Browser receives provider events and forwards tool calls with an expiring session credential | Provider calls are correlated and deduplicated; business writes additionally require a durable review and explicit client confirmation. |
| Nest to Business Manager | Fixed integration token and fixed company binding | Scope is labelled real-estate even for legacy student calls; tenant/account mapping must become explicit. |
| Inspection booking | Business Manager transaction locks slot, checks capacity/idempotency, inserts booking and sale report state | This database receipt is authoritative. A spoken/provider acknowledgement is not. |
| Review/confirmation | P1 stores expiring, field-bound reviews in PostgreSQL | Commit requires the authenticated session, exact payload and explicit on-screen confirmation; provider/model flags alone do not authorize it. |
| Report/email queues | PostgreSQL job/delivery state and workers | Preserve queue ownership. Verify claim fencing, ambiguous provider outcomes, retry, and reconciliation before refactoring. |
| Knowledge | Business Manager queries and legacy official-page fetch/cache | Retrieved text is untrusted data. Current hardcoded fallback is incompatible with the target no-invention rule. |

### Mutation and deduplication inventory

| Mutation | Authoritative boundary | Current deduplication / fencing |
|---|---|---|
| Create inspection booking | One Business Manager PostgreSQL transaction locks the slot, rechecks capacity, inserts the booking, and for sale listings creates report/delivery state | Company plus idempotency key lookup; slot row lock prevents capacity races |
| Confirm rental booking email | Booking row plus provider attempt recorded by Business Manager | Existing sent state suppresses ordinary repeats; a provider timeout can still be ambiguous and needs later reconciliation design |
| Queue/requeue sale confirmation | Business Manager transaction locks the delivery and updates the destination/state | Delivery row lock and existing state; the report must be ready before email delivery can complete |
| Corrected-address resend | Durable runtime review gate followed by Business Manager queue/send operation | Stable command identity and Business Manager receipts prevent automatic repetition of ambiguous outcomes |
| Report generation and sale delivery | PostgreSQL claimed jobs/deliveries | Advisory cycle lock, leases, `locked_by`, renewal, and worker-owner predicates fence completion; later tests must inject stale/duplicate claims |

## Failure-injection specifications for later phases

These are specifications, not P0 execution claims:

1. Restart after review: a valid durable review should survive; expired or changed fields must fail. Current in-memory state is expected to fail this requirement.
2. Timeout after booking commit: retry with the same command/idempotency identity must return/reconcile the existing booking without duplication.
3. Duplicate provider callback/tool event: one canonical provider call ID may produce at most one accepted mutation lifecycle.
4. Duplicate worker claim: only the active lease/fencing owner may complete a report or delivery attempt; stale completion must be rejected.
5. Ambiguous email-provider timeout: state remains unknown/reconcilable and is never announced as sent without provider acceptance evidence.
6. Domain switch: real-estate review state cannot authorize a student action, and student state cannot become part of a new v2 release.

## Quarantine exit decision

Before any port, decide whether student agency is archived, maintained as a separately deployed legacy pack, or rebuilt later against generic capabilities. That decision must not block P1 core work and must not place student terminology or tools into core/capability modules.

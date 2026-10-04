# P6-04 preflight — release remains blocked

Date: 2026-10-04 (Australia/Brisbane)

## Decision

P6-04 has not passed and production release readiness is not claimed. This
preflight executed the safe offline gates, inventoried the adversarial matrix,
ran and remediated the production-dependency audits, executed the isolated SQL
gate and defined the remaining fault/security work.
Formal P6-04 execution still depends on completion of P6-A06, including the
genuine-customer activation decision.

No live provider, email, payment or production mutation was invoked. Checkout,
live overage collection and live milestone collection remained disabled.

## Executed evidence

| Gate | Result | Evidence |
| --- | --- | --- |
| Runtime unit/contract suite | Pass | 135 suites, 503 tests |
| Runtime portability typecheck | Pass | Provider-neutral core boundary compiled |
| Runtime production typecheck/build | Pass | Both commands completed |
| Generated contract drift | Pass | Generated contracts match source |
| Backend release suite | Pass with declared exclusions | 23 suites, 97 tests; SQL tests are a separate opt-in gate |
| Disposable PostgreSQL SQL gate | Pass | 4 suites, 11 tests; the separately authorised real-email test was explicitly disabled and skipped |
| Protected real-estate regression | Pass | 8 suites, 38 tests |
| New-product/student boundary | Pass | 241 source files scanned |
| Frontend Sophia/Admin suite | Pass | 84 ChromeHeadless tests |
| Frontend typecheck/build | Pass with existing build warnings | Browser-only production application built |
| Credential-pattern scan | Pass as a heuristic | No repository candidate matched live Stripe/webhook, AWS access-key, private-key, GitHub-token or Slack-token patterns; dependencies, build output and lockfiles were excluded |
| Runtime production dependencies | Pass | `npm audit --omit=dev`: zero findings |
| Backend production dependencies | Pass for release-blocking severities | 4 moderate findings; 0 critical and 0 high after bounded owner upgrades |
| Frontend production dependencies | Pass | Zero findings after the Angular patch alignment |
| Frontend full build/test dependency tree | Pass for critical threshold with maintenance remaining | 0 critical, 14 high and 4 moderate; remaining findings are development/build/test-only |
| Container image scan | Not run | Docker Scout 1.17.0 is installed, but the Docker daemon is inaccessible; a daemon-free `fs://` scan was also attempted and stopped at the required Docker login |

The SQL-gated release tests were deliberately not pointed at the configured
shared/production database. A localhost-only PostgreSQL cluster was created
under `/tmp`, seeded with the minimum repository schema, run with the opt-in
real-email test disabled, then stopped and permanently removed. Its first run
correctly exposed that the base demo SQL needed the repository's later `city`
migration before the current email-claim query could be planned; the complete
rerun then passed.

## Adversarial matrix preflight

`Pass (offline)` means the matching deterministic tests executed in this
preflight. `Partial` means useful unit/schema evidence passed but the prescribed
process, database, restart or provider boundary was not exercised. It does not
mean the full release scenario passed.

| Plan scenarios | Status | Current evidence and remaining work |
| --- | --- | --- |
| T07-T09 confirmation forgery, mutation and scope/expiry | Pass (offline) | Explicit-confirmation, session-scoped review and durable-review tests passed. |
| T10-T12 callback/call replay, timeout reconciliation and idempotency conflict | Pass (offline) | Duplicate provider-call rejection, authoritative receipt reconciliation, unknown-outcome no-retry and stable-idempotency tests passed. |
| T15-T17 workflow/session separation, honest delivery state and overlapping tenant IDs | Pass (offline) | Queue/report independence, provider-acceptance labeling, connector binding and tenant-isolation tests passed. |
| T19 forged tenant/company/provider authority | Pass (offline) | Business Manager and Runtime connector-authority tests reject caller-selected company, tenant and scopes. |
| T28-T30 hostile prompts/tools, unsafe media/SSRF and webhook forgery/replay | Pass (offline) with limits | Code-enforced tool grants, fixed-host media policy, text-only rendering, source-fetch rejection and signed/replayed billing callback tests passed. Active product outbound integrations still need an external penetration test. |
| T31-T34 privacy, failover policy, usage replay and student exclusion | Pass (offline) with limits | Privacy, provider-policy, deduplicated/incomplete usage and boundary tests passed. Live downstream deletion/failover evidence remains separately gated. |
| T36 provider SDK boundary | Pass (offline) | Portability typecheck and architecture boundary scan passed. |
| TA01-TA05 Admin identity, tenant and role boundaries | Pass (offline) with limits | Runtime-token denial, direct cross-tenant denial, fixed-role/no-elevation policy, invitation lifecycle and last-owner tests are present in the executed suite. No authenticated multi-account browser E2E exists. |
| TA06-TA07 concurrent authoring and prompt-policy bypass | Pass (offline) | Optimistic draft conflict, immutable release/session references and code-owned grant/privacy controls passed. |
| TA08 knowledge ingestion abuse | Partial | Malicious/oversized/unsupported and cross-tenant revision tests passed; the malware scanner/private intake worker remains deployment-disabled and has no live evidence. |
| TA09-TA12 connector sandbox, secrets, workflow retry and escalation | Pass (offline) with limits | Synthetic-only sandbox, cross-tenant binding, credential non-disclosure, pinned workflow and durable internal escalation evidence passed; external callback/notification/transfer adapters remain unavailable. |
| TA13-T17 content/export, evaluations, analytics, audit and billing semantics | Pass (offline) with limits | Permission separation, plain-text rendering, no-effect evaluations, deduplication/timezone/missing-data handling, redaction and usage-versus-charge labeling passed. High-volume private export workers remain unavailable. |
| TA18-TA19 billing callback abuse and unrelated payment isolation | Pass (offline) | Signature/environment/account/tenant/product mapping, replay/order handling and disabled-live-mutation tests passed. No live charge was attempted. |
| T06 two-process review restart | Partial | Durable store/factory recreation passes; two independently running replicas have not been tested. |
| T13 capacity contention | Partial with SQL evidence | Atomic admission/capacity tests and a real PostgreSQL competing-booking serialization test pass; the prescribed two-runtime-replica commit race remains unrun. |
| T14 worker crash/lease expiry | Partial with SQL evidence | Fenced-lease, transaction-scoped worker-lock and single-claim tests pass against PostgreSQL; actual process termination/lease reclaim remains unrun. |
| T18 pooled SQL reuse | Partial | Transaction-local context on a pooled client passes; a two-tenant disposable-database soak has not run. |

## Dependency finding triage

The production audits are a point-in-time preflight result, not a complete
exploitability assessment.

### Backend

The critical `fast-xml-parser` 5.2.5 path was removed by aligning the five used
AWS SDK packages at 3.1146.0 and removing the unused direct credential-provider
dependency. The parser is absent from the installed tree.

The remaining high paths were remediated through their direct owners:

- Axios 1.20.0, including FormData 4.0.6;
- Express 5.2.1, with `path-to-regexp` refreshed to 8.4.2;
- Google GenAI 2.27.0, with `ws` refreshed to 8.22.0;
- JsonWebToken 9.0.3, with patched JWS selections;
- Nodemailer 10.0.14; and
- Sharp 0.35.5.

A no-network Node 22 smoke exercised AWS client construction, GenAI's model
surface, Express route compilation, JWT sign/verify, Nodemailer JSON transport,
Axios loading and an in-memory Sharp conversion. The full release, boundary and
protected real-estate suites passed afterwards. The final production audit has
0 critical, 0 high and 4 moderate findings (`morgan`, `node-cron`,
`stream-json`, and `uuid`); these remain tracked but do not satisfy a
release-blocking severity threshold.

### Frontend

The SSR-specific Router advisory was removed by aligning the Angular framework,
including Router, at 21.2.25 and the Angular build/CLI/DevKit at 21.2.24. This
application remains browser-only, but no reachability exception is now needed:
the frontend production audit has zero findings.

The full audit also exposed a critical development-time Piscina 5.2.0 path
pinned by Angular Build. A narrow same-major override to Piscina 5.3.2 removed
that critical finding, and the patched worker passed the 84-test suite,
typecheck and production build. The full tree still reports 14 high and 4
moderate findings confined to development/build/test packages; these remain a
maintenance queue and are not present in `npm audit --omit=dev`.

## Threat model checkpoint

Protected assets are tenant data and configuration, administrator/MFA identity,
connector/provider credentials, authoritative booking and delivery receipts,
privacy/audit evidence, and commercial/billing records. Principal trust
boundaries are browser-to-Business-Manager, Business-Manager-to-Runtime,
Runtime-to-PostgreSQL, worker lease handoff, outbound provider calls and signed
provider callbacks.

The principal threats and current controls are:

- authority forgery or tenant confusion: server-resolved identity, fixed roles,
  recent MFA, tenant transactions, RLS and connector bindings;
- replay and duplicate business effects: canonical payload digests, durable
  receipts, unique constraints, idempotency keys and fenced leases;
- prompt/HTML/media injection: compiled grants, explicit confirmation,
  structured text rendering and exact-host media policy;
- SSRF/credential disclosure: fixed provider endpoints, restricted connector
  credentials, redacted audit/export paths and no browser secret input;
- billing forgery/cross-product mutation: signed callbacks, provider-account,
  environment, tenant, plan and Price mapping, with all live collection gates
  default-off;
- dependency/container compromise: the production dependency tree now has no
  critical/high findings, but the exact release-image scan remains absent.

Residual risks requiring release evidence are real two-replica/database fault
behavior, process-kill lease recovery, container contents and an independent
penetration test.

## Required completion sequence

1. Finish P6-A06 only when the genuine customer record and separate live-switch
   authorities exist; obtain fresh MFA immediately before any activation. This
   preflight does not authorize that activation.
2. The isolated SQL-gated suite is complete. Extend the disposable environment
   to two Runtime replicas and run review/commit, competing slot/admission,
   worker kill/lease reclaim and timeout-after-authoritative-commit recovery.
3. Critical/high production dependency remediation is complete, the frontend
   production tree is clean, and both complete dependency trees have zero
   critical findings. Continue to track the backend's four production-moderate
   and the development-tool findings and rerun audits after lockfile changes.
4. Authenticate an approved scanner, build the exact release images and run an
   image/container vulnerability scan; record image digests and disposition
   every critical/high finding. The unauthenticated Scout filesystem attempt
   did not produce scan evidence.
5. Commission an independently authorised penetration test against a staging
   deployment with two synthetic tenants and no production secrets or live
   collection. Scope identity/MFA, tenant/object ID isolation, uploads/exports,
   SSRF, XSS, connector authority, callbacks/replay, rate/DoS limits and billing
   account/product isolation. Do not represent scheduling or a plan as a pass.
6. Rerun the complete P6-04 matrix and record zero unauthorised/cross-tenant
   commits and zero duplicate booking/initial-delivery effects before changing
   the task status.

## External-effect statement

This preflight made no Stripe request, created no Customer, subscription,
invoice, Checkout Session or charge, sent no email, mutated no production data
and changed no live billing switch.

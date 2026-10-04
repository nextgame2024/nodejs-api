# P6-05 service-objective preflight

## Decision

P6-05 is **not formally started or passed**. Its hard prerequisite P6-04 is
blocked, and the repository has no complete live benchmark dataset or approved
service objectives. Production provider activation must remain blocked.

This preflight establishes the measurement contract, supported-composition
ownership and draft operational playbooks. It makes no live latency,
availability, recovery or cost claim. No live provider, email, billing or
production-data request was made.

The machine-readable register is `p6-05-evidence-register.json`. Run:

```sh
npm run operations:check-service-objectives
```

That command verifies the register is structurally complete while reporting
the missing evidence. The strict command `npm run operations:audit-service-objectives`
must exit non-zero until dependency, evidence, approval and rehearsal gates all
pass.

## Supported compositions and ownership

| Experience | Current baseline composition | Accountable owners | Rollback boundary |
| --- | --- | --- | --- |
| Essential | Native realtime | Sophia Runtime and kiosk | Stop new allocation, preserve or gracefully close pinned sessions, reconcile provider resources. |
| Professional | Orchestrated voice with presentation adapter | Runtime, kiosk and presentation-adapter owners | Stop new allocation; never substitute an unapproved speech/avatar owner; reconcile every partial allocation. |
| Premium | Composite realtime | Runtime, kiosk and composite-provider owners | Stop new allocation; close the pinned composite session; never change reasoning ownership mid-session. |

These are baseline composition identities, not proof that every provider behind
them is live-ready. The Gemini Live and server-orchestrated voice work remains
separately gated where already recorded in the implementation progress.

## Measurement contract

Every sample must include: UTC timestamp, environment and release digest,
experience and resolved profile version, adapter versions, warm/cold label,
mocked/live label, browser/runtime/provider regions, network class, metric
start/end event names, duration, outcome, correlation ID, dataset ID and cost
evidence status. Logs must exclude credentials, raw audio, transcript content
and personal data.

Required clocks and boundaries:

| Metric | Start | End | Required separation |
| --- | --- | --- | --- |
| Startup | Admission request accepted | Browser reports the resolved composition ready | Runtime admission/allocation, provider creation, persistence, browser transport and presentation stages |
| First audio | Accepted user turn or explicit greeting request | First audible assistant frame | Backend, provider, network and browser playback |
| Interruption | Speech-start/interrupt request | Output stopped and stale buffers discarded | Browser dispatch, provider acknowledgement and local buffer clear |
| Tool execution | Tool request accepted | Terminal result available to the caller | Policy/database, connector, business effect and provider bridge |
| Concurrency | Load interval starts | All admitted work terminates or is safely rejected/cleaned | Admission, provider quota, database contention, error and cleanup rates |
| Report duration | Authoritative report job created | Terminal report-generation state | Generation is distinct from delivery acceptance and verified delivery |
| Delivery queue age | Item becomes eligible | Claim/provider acceptance/verified delivery milestones | Oldest eligible age, claim latency, provider acceptance and verified delivery |

Use monotonic clocks for durations and wall-clock UTC only for correlation.
Record failures and censored/time-out samples rather than discarding them.
Report count, success/error/timeout totals, median, p95, p99, maximum and the
raw bounded dataset. Do not combine warm with cold, mocked with live, or
provider/network time with backend time.

The benchmark design requires at least 30 independent cold samples and 100
warm samples per supported composition before proposing a percentile target.
Those counts are a collection protocol, not a performance promise. Live runs
also require explicit credentials, approved data handling, a cost ceiling and
stop conditions. Mock results can detect regressions but cannot establish live
voice latency or provider availability.

## Current evidence inventory

- Runtime session creation currently logs total server-side creation time, but
  not durable correlated allocation/provider/persistence segments.
- The kiosk currently logs runtime-session-created and ready elapsed time, but
  not an exportable dataset with release/profile/network metadata.
- Tool calls persist `duration_ms`, status and timestamps. This can support a
  tenant-scoped tool distribution once the exact release/profile linkage and
  benchmark dataset are selected.
- Operational status exposes provider-cleanup, workflow-retry and operations
  inbox queue counts and oldest age. It does not yet cover every report/email
  queue or constitute a delivery SLO.
- Provider usage evidence distinguishes measured, estimated and incomplete
  usage and keeps cost estimates separate from customer charges. No approved
  provider-cost-per-session ceiling exists.
- Mock tests prove interruption/buffer-clear behavior and partial-startup
  cleanup semantics. They contain no valid live timing or availability sample.

Accordingly the evidence register deliberately contains zero performance
observations and every objective remains `unapproved` with a null target.

## Proposed approval process

1. Complete P6-04 and preserve its release/image/security evidence digest.
2. Add correlated, privacy-minimised instrumentation for every clock boundary.
3. Run deterministic mocked warm/cold and concurrency datasets in CI or a
   disposable environment; store the raw bounded results and release digest.
4. Under separate explicit authority, run budget-capped live samples with
   synthetic data for only the provider compositions being enabled.
5. Review distributions, failure modes, estimated provider cost per successful
   session and observed cleanup behavior. Propose targets and regression
   budgets only from that evidence.
6. Obtain named operational/product approval and change each register target
   from unapproved to approved. Missing evidence blocks that composition.
7. Rehearse all playbooks below and attach timestamps, participants, evidence,
   defects and follow-up owners before the strict audit may pass.

## Operational runbooks

All runbooks use the same safety rule: stop new affected sessions first,
preserve authoritative business effects and receipts, and never recover by
replaying an unknown mutation.

### Provider outage

Detect through failed health policy, session-allocation errors, quota response
or a measured error-rate breach. Disable the affected profile for new sessions
and show an accurate unavailable/text-fallback message only where that fallback
is already approved. Do not silently change vendor, jurisdiction, retention or
capability ownership. Let healthy pinned sessions finish where safe; otherwise
quiesce, close and reconcile resources. Recovery requires provider health,
synthetic startup/turn/tool checks within the approved budget and observation
of cleanup queues. Roll back by keeping the provider disabled and returning new
sessions to the last approved profile version.

### Partial startup

Correlate the allocation ID, stage and any non-secret provider resource IDs.
Reject readiness, close all known resources, and leave a durable cleanup item
when immediate close fails. Verify that no active Sophia session is exposed,
the allocation becomes released, repeated cleanup is safe and no usage is
mislabelled complete. Roll back the new profile/adapter for new sessions if
cleanup or leak evidence is incomplete.

### Queue backlog

Confirm queue owner, oldest eligible age, lease state and whether work is a
safe read, idempotent compiled workflow or non-replayable mutation. Pause new
optional work before increasing consumers. Reclaim only expired leases through
the documented owner; never run simultaneous worker ownership or generic tool
replay. Verify count/age decline, stale workers cannot complete another lease,
and provider acceptance is not reported as delivery. Roll back worker changes
while leaving authoritative jobs and receipts intact.

### Privacy incident

Disable the affected ingestion/session/profile path and preserve redacted,
tenant-scoped audit evidence. Do not copy suspected personal data into tickets
or chat. Identify tenant, categories, processors, regions, retention targets
and active legal holds; invoke only approved privacy-owner workflows. Credential
rotation, provider deletion and notification require their designated owners
and evidence. Recovery requires containment verification, access review,
downstream evidence and authorised sign-off; rollback keeps the affected path
disabled without deleting required audit/hold records.

### Release rollback

Freeze new v2/profile allocation and route only new sessions to the last
approved compatible release. Existing sessions remain pinned or close with an
accurate message. Never restore an old database over committed bookings,
receipts, billing evidence or jobs. Reconcile in-flight commands by durable
receipt, drain/recover queues through their lease owners, and verify schema
compatibility, tenant isolation, cleanup and key health checks. Forward-fix if
an additive migration cannot safely be reversed.

## Remaining gates

- P6-04 completion, including its unresolved release-image, two-replica/fault
  injection and independently authorised penetration-test evidence.
- Correlated instrumentation and complete mocked datasets.
- Explicitly authorised, synthetic, budget-capped live datasets per production
  composition.
- Approved latency, availability/regression, cost-per-session and failover
  limits.
- Recorded successful rehearsal of all five runbooks.
- The independent commercial/customer gates already tracked under P6-A06.

Checkout, live overage collection and live milestone collection remain disabled.

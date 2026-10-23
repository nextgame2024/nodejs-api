# Sophia Runtime API

NestJS TypeScript service for Sophia realtime assistant sessions, provider adapters, avatar adapters, and trusted business tools.

This service is intentionally separate from the existing Express API in `backend/src`.

Runtime target: Node 22.

## Local Setup

```bash
cd backend/sophia-runtime
fnm use 22.23.2
npm install
cp .env.example .env
npm run migrate
npm run build
npm test
npm run start:dev
```

For Phase 1, `SOPHIA_RUNTIME_DATABASE_URL` can point to the existing Neon database while using `SOPHIA_RUNTIME_SCHEMA=sophia_runtime`. For production, prefer a dedicated Sophia Runtime Neon database or project.

Runtime connections must use `SOPHIA_RUNTIME_DATABASE_ROLE=sophia_runtime_app` (or a directly authenticated equivalent role) so PostgreSQL row-level security is enforced. The migration connection remains the schema owner and deliberately does not assume this role. Never run the application with an owner, superuser or `BYPASSRLS` effective role.

## Render

Create a separate Render service scoped to `backend/sophia-runtime`.

Build command:

```bash
npm ci && npm run build
```

Start command:

```bash
npm run start
```

Run migrations before deployment:

```bash
npm run migrate
```

Do not copy secrets into Angular. Browser clients should call this runtime API for short-lived session metadata only.

## Xero connector foundation

Xero uses a shared, multi-tenant OAuth 2.0 connector. A Student Operations Chief Executive can begin consent through
`POST /api/business-packs/student-operations/v1/workspace/integrations/xero/authorization`.
The registered Xero callback must exactly match `XERO_REDIRECT_URI`; locally it is
`http://localhost:3400/api/connectors/xero/v1/oauth/callback`.

Configure `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_REDIRECT_URI`, `XERO_RETURN_URL`,
`XERO_OAUTH_STATE_SECRET`, `XERO_TOKEN_ENCRYPTION_KEY`, and `XERO_WEBHOOK_KEY` only in the runtime environment.
The connector requests identity, offline access, `accounting.settings.read`, `accounting.invoices.read`, and
`accounting.contacts.read`. It can verify the selected organisation, list bank-account metadata, and produce a
tenant-scoped read models from paged sales invoices and contacts. By default it cannot write accounting data.
Existing connections must be re-authorized when the invoice/contact scopes are introduced. Each Xero
organisation is persisted as a tenant-scoped connector binding, allowing one agency to connect TRUST and operating
organisations independently and allowing other agencies to connect their own organisations later.

Normal Students page, search, and infinite-scroll requests read PostgreSQL only. A Chief Executive can enqueue a
durable refresh with `POST .../student-sync`; the scheduler performs initial/incremental/reconciliation paging and
the UI keeps the last successful projection when Xero is unavailable. The legacy inline scheduler uses
`XERO_SYNC_SCHEDULER_ENABLED=true`. For the opt-in shared nightly worker and
API enqueue-only cutover, follow [the worker runbook](../docs/sophia/student-sync-worker-cutover.md);
do not leave the legacy scheduler enabled after that cutover. Configure the Xero webhook endpoint as
`/api/connectors/xero/v1/webhooks`; signed events coalesce into the same durable queue. Candidate acceptance links a
Xero contact to a reviewed operational student without writing to Xero.

### Student document storage: primary Contact and first upload

Apply owner migration `090_student_primary_xero_contacts.sql` after 089. It adds an RLS-protected,
student/organisation primary destination and a narrow tenant-filtered projection of existing reviewed Contact
links. It does not change users, passwords, historical Contacts, invoices or documents, or call Xero.

Chief Executive/Operations document-management permissions are unchanged. On the first explicit upload for
a saved student, the API selects the active Contact used by the most recent non-void/deleted invoice in the
active TRUST organisation and persists it across all the student's cases. An exact Sophia external reference
takes precedence; an explicitly reviewed Contact link without invoices can also be reused. Ties/no invoice
dates use provider last-updated time, then Contact ID. Xero does not expose a dependable creation date.
The persisted primary is not repicked when invoice activity changes. Archived primaries or ambiguous TRUST
organisation configuration fail closed for administrator review; no historical Contacts are merged or deleted.

If no Contact is linked, both new and existing students can provision storage on their first upload, without
an invoice. The durable intent snapshots the name/email and uses `sophia:<runtime student UUID>` as its unique
ContactNumber. A two-minute student/organisation lease serializes concurrent cases. Every attempt looks up
that exact reference before creating, including after Xero's six-minute idempotency cache expires. The
provider call happens outside database transactions, uses shared operational quota/backoff and does not
blindly retry writes. A timeout retains the intent; retry the same file after two minutes. No provider calls
or primary-binding writes occur on ordinary page viewing or upload-options GETs. File metadata remains
associated with the explicitly selected Sophia case. Invoice attachment linking and S3 remain deferred.

Release order: keep uploads disabled during rollout; deploy updated Runtime API, shared worker and
Business Manager (`nodejs-api`) code, apply owner migrations 090 and 091 in order (skip already applied
migrations through the existing ledger), deploy the frontend, then explicitly enable **on Runtime API only**:

```text
XERO_ATTACHMENT_UPLOAD_ENABLED=true
XERO_CONTACT_CREATION_ENABLED=true
```

An integration administrator must reauthorize Xero from company integrations to grant `accounting.attachments`
and `accounting.contacts`. Deploy the updated worker before reauthorization: its read checks accept full
Contacts permission in place of Contacts read-only permission. Invoice/payment write permissions remain
unrequested. Disabling Contact creation does not prevent uploads to an already linked Contact; disabling
attachment uploads stops file writes. Roll back feature flags/UI without deleting bindings or provider files.
Older frontend requests may only resume their already-persisted upload; new uploads require the refreshed UI.

Xero [limits each Contact to ten attachments](https://developer.xero.com/documentation/api/accounting/contacts).
Migration 091 adds automatic **document-only overflow**, approved while S3/AWS migration is deferred:

- Preserve the primary billing Contact. Prefer it for uploads, then reuse other active explicitly linked
  Contacts, then create `Student (STD-n) — Documents 2`, `Documents 3`, etc. only as capacity is needed.
- Document destinations are student/organisation scoped and shared across cases. Each file remains linked
  to its originating case in Sophia. Discovery excludes Sophia-uploaded files belonging to another case;
  historical imported files retain their existing discovery behaviour. No historical files are moved/deleted.
- RLS-protected destination records store stable `sophia:<student UUID>:docs:<ordinal>` references, Contact
  creation snapshots and fenced leases. Provider creation is outside transactions and reconciles by exact
  external reference before retrying. No extra Sophia student, case or invoice is created for an overflow.
- Allocation locks the destination row and counts live provider files plus outstanding local reservations
  whose filenames are not yet visible upstream. This prevents concurrent cases/actors/replicas from taking
  the same last slot. Reservations are conservative: timeouts and completed-but-not-visible files are not
  blindly refunded. Full observations persist; deleted remote files do not automatically reclaim capacity.
- A provider capacity check rejects before byte PUT when necessary; only such an unattempted reservation
  may safely reroute. Once PUT might have happened, the upload stays pinned to its destination. Recovery
  finds its durable filename and verifies remote content size/SHA-256 before accepting the receipt, rather
  than overwriting/relying on Xero's six-minute key cache. Byte PUT is fenced after operational admission.
- Contact allocation bounds provider work to twelve destinations per request and three pre-PUT reroutes.
  Very large historical collections, concurrent provisioning, Xero outages/quota or stale leases can require
  retrying the same file after two minutes. Progress/intent persists; files themselves remain in the browser
  until confirmed and are never staged in PostgreSQL. This is not an outage-proof/offline upload queue.
- Sync users recognises explicit managed storage mappings, rejects conflicting identities, repairs Contact/
  invoice links to the existing student and excludes managed Contacts from fuzzy new-user grouping. The
  mapping lookup is additive when 091 is absent; deploy worker and nodejs-api together before enabling.

No additional OAuth scopes or environment flags beyond 090 are needed. Existing `accounting.contacts` and
`accounting.attachments` consent must already be granted; an administrator reauthorizes only if missing.
New stores deny direct deletion, including inherited default grants. Old in-flight uploads are marked as
already attempted by 091 and cannot be silently retargeted. Roll back upload enablement/code without
deleting overflow Contacts, reservations or provider receipts. S3 and invoice-document linking remain deferred.
App uploads retain PDF/JPEG/PNG and the 10 MB limit. No live Contact creation/file upload or production migration
is part of local verification; use an explicitly approved real student/file for release smoke testing.

## Sophia subscription billing

Sophia subscriptions use an independently configured Stripe adapter. It never
falls back to the legacy Business Manager `STRIPE_*` variables used by Toolkit
and video purchases. `stripe_sandbox` is charge-safe test mode; `stripe_live`
keeps Checkout disabled unless `SOPHIA_BILLING_LIVE_CHECKOUT_ENABLED=true` is
separately authorised. Live overage collection and Founding milestone invoicing
have distinct default-off switches so enabling one path cannot implicitly enable
another. Required values are validated for each enabled path; a base-plus-overage
sandbox deployment uses:

```bash
SOPHIA_BILLING_PROVIDER=stripe_sandbox
SOPHIA_BILLING_PROVIDER_ACCOUNT_KEY=legacy-primary
SOPHIA_BILLING_LIVE_CHECKOUT_ENABLED=false
SOPHIA_BILLING_LIVE_OVERAGE_ENABLED=false
SOPHIA_BILLING_LIVE_MILESTONE_ENABLED=false
# Set only after the final activation audit and explicit real-charge authority:
# SOPHIA_BILLING_LIVE_ACTIVATION_CONFIRM=I_AUTHORIZE_SOPHIA_LIVE_CHECKOUT_FOR_APPROVED_CUSTOMERS
SOPHIA_BILLING_STRIPE_SECRET_KEY=sk_test_...
SOPHIA_BILLING_STRIPE_WEBHOOK_SECRET=whsec_...
SOPHIA_BILLING_STRIPE_PORTAL_CONFIGURATION_ID=bpc_...
SOPHIA_BILLING_STRIPE_COMMITTED_PORTAL_CONFIGURATION_ID=bpc_...
SOPHIA_BILLING_STRIPE_PRICE_MAPPINGS={"commercial-plan-version-uuid":"price_..."}
SOPHIA_BILLING_STRIPE_INITIAL_PRICE_MAPPINGS={"commercial-plan-version-uuid":{"commencement":"price_..."}}
SOPHIA_BILLING_STRIPE_MILESTONE_PRICE_MAPPINGS={"commercial-plan-version-uuid":{"production-deployment":"price_..."}}
SOPHIA_BILLING_STRIPE_METERED_PRICE_MAPPINGS={"commercial-plan-version-uuid":"price_..."}
SOPHIA_BILLING_STRIPE_OVERAGE_PRICE_MAPPINGS={"commercial-plan-version-uuid":"price_..."}
SOPHIA_BILLING_STRIPE_METER_BINDINGS={"active-overage-minutes":"sophia_active_overage_minutes"}
SOPHIA_BILLING_CHECKOUT_SUCCESS_URL=https://admin.example/sophia-admin/usage-billing?checkout=success
SOPHIA_BILLING_CHECKOUT_CANCEL_URL=https://admin.example/sophia-admin/usage-billing?checkout=cancelled
SOPHIA_BILLING_PORTAL_RETURN_URL=https://admin.example/sophia-admin/usage-billing
```

The base mapping is a recurring licensed Price. Initial mappings are optional,
plan-version and component-key scoped one-time Prices that appear only on the
initial subscription invoice; a plan without immutable initial charge
components ignores this mapping. Milestone mappings are separate approved
one-time Prices used only after a recent-MFA billing administrator records
immutable acceptance evidence; submission and exact finalized-line
reconciliation are environment-scoped and idempotent. The overage mapping is a
separate one-time Price used by the draft-renewal invoice-adjustment and
missed-window carry-forward paths; Meter-backed mappings remain independent
usage-delivery evidence. In live mode, overage invoice adjustment, recovery and
Meter submission require `SOPHIA_BILLING_LIVE_OVERAGE_ENABLED=true`, while a
Founding production-deployment invoice requires
`SOPHIA_BILLING_LIVE_MILESTONE_ENABLED=true`. Both default to false and neither
enables Checkout. Exact reconciliation remains available after either collection
switch is turned off so in-flight obligations can be resolved safely.

The committed portal configuration must be active in the same Stripe mode and
must disable subscription cancellation. A paid initial subscription invoice
anchors any minimum commitment to the exact first provider billing period. The
runtime counts contiguous observed provider periods and uses the committed
portal before the exact final-period boundary; at or after that boundary it uses
the standard active portal configuration, which must enable cancellation. The
provider subscription metadata must pin the same immutable commercial plan.
This does not create a local cancellation scheduler or claim that Stripe
guarantees collection of the contractual term.

Founding sandbox resources and proof fixtures are operator-only workflows:

```bash
SOPHIA_FOUNDING_CATALOG_CONFIRM=I_UNDERSTAND_THIS_PUBLISHES_A_COMMERCIAL_PLAN \
npm run commercial:publish-founding

SOPHIA_FOUNDING_PLAN_VERSION_ID=<published-plan-uuid> \
SOPHIA_FOUNDING_CONFIRM=I_UNDERSTAND_THIS_CREATES_STRIPE_SANDBOX_OBJECTS \
npm run billing:founding-provision

SOPHIA_FOUNDING_PLAN_VERSION_ID=<published-plan-uuid> \
SOPHIA_FOUNDING_TENANT_ID=<isolated-proof-tenant-uuid> \
SOPHIA_FOUNDING_CONFIRM=I_UNDERSTAND_THIS_CREATES_STRIPE_SANDBOX_OBJECTS \
npm run billing:founding-sandbox -- prepare
```

The compiled Founding publisher derives the already-approved seller identity
from the configured sandbox provider account, so it does not require the legal
catalog JSON to be reconstructed in a production shell. Publication and
provisioning are idempotent by immutable database identity, Product metadata
and Price lookup keys. Stripe provisioning
refuses non-test keys, and prints mapping entries to merge with existing Render
JSON values. The proof stages are `prepare`, `close`, `milestone`,
`advance-commitment`, and `status`; they create Stripe sandbox objects and must
never be run against a real tenant.

Commercial plan entitlements remain provider-neutral. Runtime safety/capacity
controls can only lower those ceilings and are configured independently:

```bash
SOPHIA_PROVIDER_SESSION_CAPACITY={"lifecycle-adapter-key":3}
SOPHIA_TOOL_READ_SEARCH_CALLS_PER_MINUTE=15
SOPHIA_TOOL_MUTATION_CALLS_PER_MINUTE=15
SOPHIA_TOOL_SENSITIVE_CALLS_PER_MINUTE=15
SOPHIA_TOOL_CALLS_PER_MINUTE_BY_TOOL={"booking.commit":5}
```

Provider-capacity keys are internal lifecycle-adapter identifiers, not vendor
names embedded in plans. The effective session ceiling is the minimum of the
commercial entitlement, tenant guardrail, platform cap, and configured capacity
for the selected adapter. An explicit `default` key may represent a verified
platform-wide fallback; without an adapter key or that fallback, new sessions
fail closed. Tool class and per-tool values are operational abuse
guards and may not raise the commercial aggregate limit.

The provider-account key is a stable internal identifier, not a secret or a
Stripe API key. Keep `legacy-primary` for the existing Stripe account during the
expand rollout. Changing it creates a different billing identity scope and must
be handled as an explicit provider-account migration, not routine secret
rotation.

The signed endpoint is `POST /api/billing/v1/webhooks/stripe`. Raw bodies are
used only for signature verification and are never persisted. Store only opaque
customer/subscription/invoice references and payload digests. Hosted actions and
reconciliation require `billing.manage` plus recent MFA.

Before Checkout, the adapter retrieves the mapped Stripe Price and requires an
exact environment-mode match to the approved fixed plan currency, base amount and
month/year interval. This first lifecycle rejects usage-overage rate cards and
tax modes other than `not_applicable`. Base-plus-metered support requires the
separately staged active-second ledger/outbox design recorded in plan 2.1.46;
do not approximate it with per-session rounding or a single transformed tiered
Price. Sandbox observations do not assign plans, enforce
live entitlements or activate production charging.

## Provider-neutral reasoning

The server-side `ReasoningPipelineService` resolves a published reasoning adapter,
streams canonical text/usage events and sends every requested tool through the
authenticated v2 dispatcher. The OpenAI Responses adapter is registered as
`openai-reasoning-v1` and is configured with:

```bash
OPENAI_API_KEY=your-openai-api-key
OPENAI_REASONING_MODEL=gpt-5.4-mini
OPENAI_REASONING_TIMEOUT_MS=60000
OPENAI_REASONING_MAX_OUTPUT_TOKENS=4096
```

Responses are requested with provider storage disabled. Opaque continuation state
is held only for the active server turn, and canonical dotted tool IDs are translated
inside the adapter. The pipeline does not itself provide speech, avatar or native
realtime capability, and it is not a public browser credential endpoint. Browser v2
activation still requires the managed kiosk credential broker described below.

The interchangeable Claude Messages adapter is registered as
`anthropic-reasoning-v1` but is disabled by default: it is absent from published
profiles and fails closed without `ANTHROPIC_API_KEY`.

```bash
ANTHROPIC_API_KEY=your-anthropic-api-key
ANTHROPIC_API_BASE_URL=https://api.anthropic.com
ANTHROPIC_REASONING_MODEL=claude-sonnet-5
ANTHROPIC_REASONING_TIMEOUT_MS=60000
ANTHROPIC_REASONING_MAX_OUTPUT_TOKENS=4096
```

Claude continuation blocks remain only in the active adapter session. Protocol
statelessness does not prove zero data retention: before publishing a production
Claude binding, approve its data-handling assessment and verify the organisation's
applicable Anthropic retention/ZDR arrangement. No browser receives the API key.

The interchangeable Gemini Interactions adapter is registered as
`gemini-reasoning-v1` and is likewise disabled by default: it is absent from
published profiles and fails closed without `GEMINI_API_KEY`.

```bash
GEMINI_API_KEY=your-gemini-api-key
GEMINI_API_BASE_URL=https://generativelanguage.googleapis.com/v1beta
GEMINI_REASONING_MODEL=gemini-3.8-flash
GEMINI_REASONING_TIMEOUT_MS=60000
GEMINI_REASONING_MAX_OUTPUT_TOKENS=4096
```

Requests use the current Interactions `steps` schema with `store: false`. Complete
Gemini continuation steps, including encrypted thought signatures, remain only in
the active adapter session. The adapter rejects unsupported JSON Schema keywords
before network I/O instead of allowing provider-side silent constraint loss. The
common pipeline executes returned calls sequentially because Interactions can emit
parallel function calls but exposes no equivalent of OpenAI's parallel-call switch.
The Gemini Developer API may still retain abuse-monitoring data, so production
publication requires an approved data-handling assessment; guaranteed ZDR requires
the separately assessed Vertex AI deployment path. No browser receives the API key.

## Gemini native Live

`gemini-live-v1` is a separate native-realtime adapter for explicitly published v2
profiles. It does not replace `native-realtime-v1` or change existing Essential and
Professional routing. The server mints a one-use constrained token; the long-lived
`GEMINI_API_KEY` never reaches the browser.

```bash
GEMINI_LIVE_MODEL=gemini-3.8-live
GEMINI_LIVE_TOKEN_TTL_SECONDS=600
GEMINI_LIVE_NEW_SESSION_TTL_SECONDS=60
```

The token locks the model, server instructions, tool catalog, audio response,
transcription and barge-in configuration. Every tool is explicitly `BLOCKING`
because this model otherwise defaults to asynchronous function execution. Browser
tool events remain an untrusted bridge and pass through the authenticated v2
dispatcher; voice never confirms a prepared booking or other reviewed mutation.

The browser adapter validates Google's constrained WebSocket endpoint, sends PCM16
mono input at 16 kHz, plays 24 kHz PCM through one Web Audio owner, processes every
audio part, maps provider-local tool names and clears queued output on interruption.
No SessionResumptionConfig is enabled: current Google documentation says generated
resumption state can retain text, audio and video for up to 24 hours. Sessions are
capped at 540 seconds, before the documented approximate ten-minute connection-reset
boundary. Longer sessions require a separately reviewed reconnection and retention
design.

Gemini Live and ephemeral tokens are still preview API surfaces even though
`gemini-3.8-live` is a stable model ID. The registration remains absent from
published profiles until preview risk, data handling, regional processing,
AI-voice disclosure and a credentialed live smoke test are approved. The Angular
transport is compiled and contract-tested, but the active kiosk facade still uses
the bounded v1 session response. Selection through a v2 profile also requires the
managed kiosk broker and descriptor/bootstrap translation recorded in P4.

## Orchestrated voice composition

The internal `OrchestratedVoicePipelineFactory` composes independently registered
transcription, reasoning and synthesis adapters with exactly one playable-audio
sink. The first real speech adapters are `openai-transcription-v1` and
`openai-synthesis-v1`. They accept and emit signed 16-bit little-endian 24 kHz mono
PCM. Input is deliberately a bounded, client-delimited turn: the runtime holds it
in memory, wraps it as WAV for `/v1/audio/transcriptions`, and emits final text only.
This is not a low-latency partial-transcription claim. TTS PCM is streamed through
the runtime with bounded output and sample-aligned chunks.

```bash
OPENAI_AUDIO_API_BASE_URL=https://api.openai.com/v1
OPENAI_TRANSCRIPTION_MODEL=gpt-transcribe
OPENAI_SYNTHESIS_MODEL=gpt-4o-mini-tts
OPENAI_SYNTHESIS_VOICE=marin
OPENAI_TRANSCRIPTION_MAX_INPUT_BYTES=2880000
OPENAI_SYNTHESIS_MAX_OUTPUT_BYTES=12000000
```

Turn epochs bind transcript, reasoning and audio. Interruption aborts work, asks the
sole sink to clear queued audio, and drops late events; audio already heard cannot be
retracted. Raw audio is not persisted by Sophia, but it does traverse this backend
and OpenAI. Deployment must approve current provider data controls and disclose that
the voice is AI-generated. This factory has no public browser route yet: authenticated
media transport still depends on the managed kiosk broker.

The generic `live-avatar-v1` and `simli-avatar-v1` registrations are avatar-only.
Their current server `sendAudioChunk` implementations do not inject media, so neither
is accepted as an orchestrated-voice audio sink until a real adapter and interruption
contract are implemented and tested. Existing browser-SDK session behavior remains a
separate legacy composition.

LiveAvatar uses its separate real-time platform. The session request can select
`avatarMode: "LITE"` or `avatarMode: "FULL"`; `LIVEAVATAR_MODE` is only the
server-side fallback when a mode is not supplied. LITE sends OpenAI's native
24 kHz PCM output to LiveAvatar. FULL requests text-only OpenAI output and lets
LiveAvatar synthesize the voice and lip-sync, avoiding duplicate output-audio
charges. For sandbox testing, configure:

```bash
LIVEAVATAR_API_KEY=your-liveavatar-key
LIVEAVATAR_MODE=FULL
LIVEAVATAR_VOICE_ID=your-liveavatar-voice-id
LIVEAVATAR_SANDBOX=true
LIVEAVATAR_MAX_SESSION_DURATION_SECONDS=60
```

Sandbox mode always uses LiveAvatar's fixed public avatar and ignores
`LIVEAVATAR_AVATAR_ID`. For production, set `LIVEAVATAR_AVATAR_ID`, disable
sandbox mode, and configure the longer session duration allowed by your plan.

## Tavus Full

The `Tavus` kiosk experience uses Tavus's complete conversational pipeline and
does not create an OpenAI Realtime session. Configure a Tavus Persona that uses
the native `tavus-gpt-oss` LLM, then add these variables to the Sophia Runtime
service:

```bash
TAVUS_API_KEY=your-tavus-api-key
TAVUS_PERSONA_ID=your-native-tavus-persona-id
TAVUS_REPLICA_ID=your-replica-id
TAVUS_NATIVE_LLM_ONLY=true
TAVUS_INTERNET_SEARCH_ENABLED=true
```

`TAVUS_REPLICA_ID` is optional when the Persona already has a default replica.
Do not set `TAVUS_NATIVE_LLM_ONLY=true` for a Persona whose LLM layer contains
an OpenAI `base_url` or API key. The runtime refuses Tavus sessions unless this
operator confirmation is enabled, and its Tavus code path never requests an
OpenAI client secret.

The runtime injects the same approved Sophia product profile into OpenAI and
Tavus conversations. OpenAI-based experiences use the `researchBusiness` tool,
which calls OpenAI Responses web search only when business research is
requested. Tavus Full attaches Tavus's native `internet_search` skill to the
PAL during an explicit deployment operation and does not use OpenAI for research. Set
`TAVUS_INTERNET_SEARCH_ENABLED=false` only when that behavior is intentionally
disabled.

See [Tavus acceptance suite](./TAVUS_ACCEPTANCE_SUITE.md) before selecting Tavus
as the production default.

### Provider catalog and cleanup operations

Customer session creation never creates, updates or attaches remote Tavus tools.
Provision each tenant/environment catalog as a versioned deployment before enabling
Premium sessions:

```bash
SOPHIA_PROVIDER_OPERATION_CUSTOMER_ID=11111111-1111-4111-8111-111111111111 \
SOPHIA_PROVIDER_OPERATION_CONFIRM=11111111-1111-4111-8111-111111111111 \
SOPHIA_PROVIDER_CATALOG_VERSION=2026-09-23.1 \
SOPHIA_PROVIDER_CATALOG_MODE=legacy \
npm run providers:provision
```

Use `legacy` while Premium sessions use the v1 compatibility API. Use
`canonical` when cutting Premium over to v2. Session opening compares the exact
tool-definition digest with the active remote deployment and fails closed when
the modes or definitions differ; changing this mode therefore requires an
explicit provider catalog deployment.

Provider resource ownership is exclusive per tenant and environment. A failed
version retains only non-secret resource IDs and may be resumed after its operation
lease expires. Premium admission fails closed when no active catalog matches the
configured persona.

Run cleanup reconciliation for each tenant from the scheduler/worker environment:

```bash
SOPHIA_PROVIDER_OPERATION_CUSTOMER_ID=11111111-1111-4111-8111-111111111111 \
SOPHIA_PROVIDER_OPERATION_CONFIRM=11111111-1111-4111-8111-111111111111 \
npm run providers:reconcile
```

Reconciliation claims expired/disconnected allocations with a database lease. Close
is idempotent, and failed cleanup remains retryable without exposing provider tokens.

## Runtime v2 canary

Runtime v2 is disabled unless the fixed runtime tenant is explicitly allowlisted:

```bash
SOPHIA_V2_CANARY_TENANT_IDS=11111111-1111-4111-8111-111111111111
SOPHIA_V2_INSTALLATION_KEY=a-random-installation-secret-of-at-least-32-characters
SOPHIA_V2_BOOTSTRAP_TTL_SECONDS=120
```

`POST /api/runtime/v2/bootstrap` requires `X-Sophia-Installation-Key` and returns
a short-lived one-time bootstrap token. Use that token as `Bearer` authentication
for `POST /api/runtime/v2/sessions`; the returned session access token then
authenticates the v2 session lifecycle and tool routes. The server resolves only
published profiles and active, non-revoked agent releases. Unsupported or stale
compositions fail before provider allocation. Check `/api/runtime/v2/readiness`
for non-secret activation status.

Existing `/api/runtime/sessions` traffic remains pinned to the v1 path. Never put
the installation key or provider credentials in a public browser bundle; an
installation backend or managed kiosk credential broker must perform bootstrap.

## Admin onboarding readiness

`GET /api/admin/v1/tenants/:tenantId/onboarding-readiness` returns a persisted,
permission-masked integration view for the tenant already resolved by Admin
authentication. It aggregates organisation access, foundational profiles,
approved content, connectors/capabilities, workflow/escalation policy, active
immutable releases, v2 session evidence and audit evidence. A caller without all
required read grants receives `activationReady: null`; restricted steps never
disclose their counts.

This is an existing-authorised-tenant assembly gate, not a platform provisioning
API. Business, provider and experience profile versions must already have been
published through their owning operational control plane. Pinned v2 session
evidence is shown separately and does not grant publication authority. Do not use
an owner/BYPASSRLS database role for the Runtime service; use the configured
`sophia_runtime_app` effective role described in
`../docs/sophia/database-role-hardening.md`.

## Operational accountability and provider usage

`GET /api/admin/v1/tenants/:tenantId/operations/status` requires
`analytics.read` and returns tenant-scoped session, tool, workflow and queue
counts together with queue-age, orphan-session, failure and denial-spike signals.
Its retry-capability section is authoritative: workflow retry is available only
when a compiled owner declares an idempotent implementation, provider cleanup is
scheduler-only, and generic session/tool replay is unsupported.

`GET /api/admin/v1/tenants/:tenantId/operations/usage` requires `usage.read` and
returns aggregate provider-independent usage dimensions split by
`incomplete`, `estimated` and `measured` evidence. Internal reasoning pipelines
write stable source-event identities; identical replay is deduplicated and a
conflicting replay is rejected. Missing final provider usage is recorded as
incomplete and may move forward through optimistic reconciliation. Measured rows
cannot be edited or deleted by `sophia_runtime_app`.

Optional cost values are provider-cost estimates and require a currency plus a
cost-table version. They are never customer charges. Budget status remains
`unavailable` until P6-A05 defines and approves tenant budget and commercial
policy. Callback requests, notification acceptance and live-transfer connection
are likewise separate evidence states; only the internal operations inbox is
currently supported.

## Private knowledge file intake

Knowledge files are disabled by default. Activation requires a dedicated private
S3 bucket with all four Public Access Block controls enabled and an authenticated
scanner implementing `GET /health` and `POST /scan`. Do not reuse the public
avatar/article bucket or `/api/uploads/presign` route.

The first bounded file set is `.txt` and `.md`, at most 1 MiB. Presigned PUTs are
bound to server-generated quarantine keys, exact length, media type, SHA-256
checksum and server-side encryption. A draft revision is created only after the
worker rechecks the bytes, receives a clean scan result and parses strict UTF-8 in
a resource-limited worker thread with a 256 KiB extracted-text cap.

Configure the Runtime API and a separate worker deployment with the variables in
`.env.example`. Run one worker per explicitly configured tenant so FORCE RLS stays
effective:

```bash
SOPHIA_KNOWLEDGE_WORKER_TENANT_ID=11111111-1111-4111-8111-111111111111 \
npm run knowledge:file-worker
```

Use `npm run knowledge:file-worker -- --once` for a scheduler invocation. The
Admin readiness endpoint remains disabled when the bucket's public-access policy
cannot be verified or the scanner health check fails. Scanner-infected and upload
metadata-mismatch objects are marked quarantined and deleted; transient failures
are retried no more than three times.

## Capability portability checks

Portable resource references use `connectorBindingId` plus a connector-opaque ID.
The current operation's distinct `capabilityBindingId` remains in its server-owned
context for grant, schema, policy and audit enforcement. This distinction permits a
catalog result to flow into availability or booking on the same connector without
allowing a same-named resource from another tenant connector.

Run `npm run typecheck:portability-core` to compile the shared capability,
orchestration, business-pack registry and tool contracts without a concrete provider
adapter or real-estate registration. The adversarial neutral fixtures are under
`test/portability`; they are test-only and are never registered as a business pack.

## Business Manager Real-Estate Demo

Real estate is a compiled optional business pack, not a Core dependency. The
default preserves the existing demo:

```bash
SOPHIA_BUSINESS_PACKS=real-estate
```

Set `SOPHIA_BUSINESS_PACKS=none` for a Core-only composition. In that mode the
runtime starts with generic approved capabilities only, publishes no property or
inspection tools, injects no real-estate instructions, and reports the
`core-tools-v1` catalog version. Unknown pack IDs fail startup rather than loading
code from configuration.

The compiled real-estate manifest owns its connector key, capability operations,
typed extension schema IDs, renderer IDs, workflow instructions and bounded v1
tool aliases. V2 sessions receive canonical capability names only; v1 sessions
retain only the legacy catalog. Changing the enabled pack set requires compatible
published profiles and provider-catalog provisioning before activation.

The real-estate tools read company-scoped listings and agency guidance from the
Business Manager API. Generate one random service token and configure the same
value on both Render services. This token is accepted by the real-estate and student-agency integration
routes; normal Business Manager user JWTs remain supported.

Business Manager (`nodejs-api`) variables:

```bash
SOPHIA_RUNTIME_SERVICE_TOKEN=a-random-value-of-at-least-32-characters
SOPHIA_RUNTIME_COMPANY_ID=81c2f065-aceb-4043-add5-b11271d21fb3
```

Sophia Runtime variables:

```bash
BUSINESS_MANAGER_API_URL=https://your-business-manager-service.onrender.com/api
BUSINESS_MANAGER_API_TOKEN=the-same-random-service-token
```

The tracked schema starts in `../scripts/sql/bm_real_estate_demo.sql`. Apply
`../scripts/sql/bm_real_estate_demo_city.sql` after it to add city-level search.
Reset the fictional presentation data, agency guidance and future inspection
slots with:

```bash
cd backend
BM_DEMO_COMPANY_ID=81c2f065-aceb-4043-add5-b11271d21fb3 \
  node scripts/seed-bm-real-estate-demo.mjs
```

OpenAI-based experiences receive all real-estate tools through the Realtime
tool registry. The explicit Tavus provisioning command deploys the equivalent PAL
tools; sessions only consume that active catalog, deliver calls through Daily app
messages, and receive matching tool results.
The OpenAI-backed public business research tool is intentionally excluded from
Tavus, which uses its native internet-search skill instead.

## Boundaries

- Core modules depend on `AIProvider`, not OpenAI directly.
- Core modules resolve `AvatarProvider` implementations per session, not at application startup.
- Live business data must flow through the `ToolRegistry`.
- Existing website/Business Manager users can be referenced by external ID, but this runtime database does not use cross-database foreign keys to the existing `users` table.

## Student agency demo release

Student knowledge, official verification, comparisons and consultations use the
same company-scoped Business Manager connection. Deploy the backend before this
runtime and the frontend. No additional runtime environment variables are needed.
The backend consultation sender accepts `SES_FROM_EMAIL` (preferred) or the
existing `SES_FROM`; region resolution is `AWS_REGION`, `SES_REGION`, then
`ap-southeast-2`. SMTP uses the existing `SMTP_*` variables. `EMAIL_PROVIDER=log`
is a preview only and cannot pass a live delivery acceptance check.

See [Phase 5 release validation](../docs/student-agency-phase5-release.md) for
repeatable tests, the demo script and deployment acceptance criteria.

# Sophia Realtime P0 repository audit

Audit date: 2026-09-22 (Australia/Brisbane)

Scope: P0-01 through P0-04 only

Target specification: `docs/sophia-realtime-codex-implementation-plan.v2.1.json`

## Evidence rules

The implementation plan is the target. `docs/sophia-realtime-architecture.json` is a reported baseline and was not treated as source-code evidence. Findings below come from repository files and commands actually inspected. No live provider, email, payment, subscription, production database, production migration, or deployment operation was run.

No `AGENTS.md` existed in either repository before this audit. P0 adds scoped pointers for future work. Both specification JSON files were already untracked backend work and were preserved without modification.

## Repository state at entry

| Repository | Branch | HEAD | Initial worktree |
|---|---|---|---|
| `backend` | `master` | `e2e6ebd9916` | Two pre-existing untracked specification/baseline JSON files |
| `frontend` | `main` | `3bbfacd7` | Clean |

P0 changes remain uncommitted. They do not change production behavior.

## Verified versions and entry points

| Area | Source-verified version/runtime | Principal entry points |
|---|---|---|
| Business Manager API | Express 5; P1 local changes require Node `22.23.2` | `src/app.js`, `server.js`, cron/worker scripts |
| Realtime API | NestJS 12.0.1, TypeScript 6.0.3; package requires Node `>=22 <23`; Docker uses Node 22 | `sophia-runtime/src/main.ts`, `sophia-runtime/src/app.module.ts` |
| Web application | Angular 21.2.2, TypeScript 5.9.x | `frontend/src/app/app.routes.ts`, `frontend/src/app/sophia-runtime` |
| Local shell observed at P0 | Node 20.15.0, npm 10.7.0 | P1 compatibility tests use installed Node 22.23.2 for both backend units |
| Database | PostgreSQL through `pg`; schemas and migrations are application-managed | Root model/config files and `sophia-runtime/src/database` |

No repository CI configuration was found. Dockerfiles exist for both backend services. The checked commands, runtime selection, and redacted configuration names are recorded in `command-map.json`.

## Actual topology

The product is currently three deployable concerns:

1. The root Express Business Manager API owns property/catalogue data, inspection slots/bookings, report jobs, delivery state, users/company data, navigation configuration, Toolkit surfaces, and existing Stripe payment flows.
2. The Nest realtime service creates provider sessions and exposes conversation/tool execution. It calls Business Manager through an integration client.
3. The Angular application contains both the Business Manager UI and the public Sophia kiosk. The kiosk still knows concrete experience/provider variants and contains real-estate and student-agency presentation code.

This is compatible with ADR-01's no-rewrite direction, but provider neutrality and durable conversation control are not yet implemented.

## Authentication and authorization findings

- Root API JWT middleware verifies a token and resolves the authoritative company ID. It does not build or enforce a general role/permission model from the user's `type`/status.
- Login tokens carry identity fields but no authoritative permission set.
- Business Manager routes commonly use `authRequired`, but management operations do not consistently enforce resource permissions.
- Navigation links can show/hide a fixed set of UI links. A hardcoded super-admin identifier is used in existing navigation behavior. Hidden links are not an authorization boundary.
- The Business Manager integration uses a fixed service token/company and labels its scope `bm:real-estate`, including for legacy student routes.
- The Angular auth interceptor attaches credentials, but `/manager` and `/sophia` routes do not establish the proposed Sophia Admin permission boundary.
- The Nest public runtime session/tool surface has no source-verified tenant Admin authentication model.

These findings make P1-01/P1-02 prerequisites for any privileged Admin API.

## Admin, knowledge, workflow, and billing inventory

Business Manager already supplies a useful authenticated shell, company/user screens, branding/navigation, and service-domain data. Reuse should mean one Angular deployment and a sibling lazy-loaded `/sophia-admin` feature. It must use dedicated Admin APIs, server-enforced tenant permissions, and fixed MVP roles. Existing menu visibility and coarse Business Manager controllers cannot serve as authorization.

The current Toolkit has tools/workflow content surfaces, but no neutral agent binding, version, publication, or release manifest. Real-estate knowledge search exists; student knowledge is legacy/quarantined; neither is the proposed generic approved-source lifecycle. Existing report/email jobs are valuable durable execution primitives.

Stripe code supports existing one-time video-render/Toolkit payments. There is no source-verified Sophia usage ledger, commercial plan/rate card, subscription lifecycle, or BillingProvider abstraction. Existing payment objects must remain isolated. No price, currency, tax, entitlement, or live billing decision is inferred.

The detailed sixteen-module assessment and permission proposal are in `admin-scope-and-permissions.md`.

## Architecture discrepancies against the target

1. Provider selection and experience composition remain vendor-aware (`AI_PROVIDER`, OpenAI/Tavus branches, vendor-specific Angular clients) rather than the proposed capability/profile registries.
2. Tool review state is held in process memory; it is lost on restart and is not the proposed durable `action_reviews` record.
3. Tool calls are persisted after success rather than as a complete requested/accepted/executing/succeeded-or-failed lifecycle.
4. `ai_configs` exists, but session creation does not source-verify a published, immutable profile/release from it.
5. Canonical provider-neutral conversation events, provider-call deduplication, and isolated provider-session state are incomplete.
6. Student-agency routes, tools, prompts, UI, schema bootstraps, and workers are compiled into the same services as the real-estate demo.
7. Student knowledge includes a runtime fallback path. That preserves current behavior but cannot satisfy the target's approved-source/no-invention rule.
8. The browser forwards provider tool events; no durable server-owned signature/deduplication boundary was verified for those messages.
9. Existing Business Manager auth is tenant-aware but not the proposed deny-by-default permission system.
10. Admin, audit, evaluation, analytics, usage, and billing modules are partial data primitives or absent, not production-ready modules.
11. P0 found runtime Node 22 and root API Node 20. P1 locally moves the root API/workers to Node 22.23.2; deployment remains pending.
12. There is no checked-in CI definition enforcing the new characterization/boundary checks.

## P0 blockers and limits

- No disposable PostgreSQL test database was identified or used, so SQL characterization tests and migrations are unrun.
- Live OpenAI/avatar/provider behavior was deliberately not invoked; RE-07 has mock/static composition evidence only.
- No browser end-to-end environment or provider sandbox was used, so UI and media quality are not certified by P0.
- No approved commercial policy or isolated billing sandbox was supplied; billing remains an audited gap.
- The student-agency delivery decision is unresolved. P0 maps it for quarantine without deleting code or data.

## P0 recommendation

Keep Business Manager as the presentation host for Sophia Admin for now: add a protected, lazy-loaded `/sophia-admin` area in the same Angular app, while building a dedicated Admin API boundary and permission registry. This retains one identity/shell/branding surface and reduces demo risk. Reconsider a separate application only when independently verified compliance, deployment ownership, or operational isolation requires it. The real-estate demo remains protected by deterministic characterization tests and by excluding legacy code from premature restructuring.

The next ready task is P1-01. Do not begin it until this P0 checkpoint is accepted.

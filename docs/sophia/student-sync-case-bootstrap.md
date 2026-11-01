# Recurring student sync: missing first case

## Confirmed production cause and repair (2026-11-01)

A tenant-scoped, read-only inspection found INV-10596 already present in the Runtime invoice cache, correctly attributed to STD-1073 / EXP Ana sofia Tobon Pelaez. It is DRAFT, AUD 1500, dated/due 2027-05-07, reference NEST ACADEMY, advisor S15 Paulina Aguillon. Invoice synchronization succeeded; no upstream invoice fetch or mutation was necessary.

The identity import audit shows `student.created` at 2026-10-29T16:16:37.776Z (30 October in Brisbane). The student had no operational profile/user link and no case. The recurring identity worker's `linkStudent` assigned the account and invoice identities but did not create an operational profile/case. The one-off existing-student migration could not cover later imported accounts. This is a missing recurring import step, not a missing invoice or date/status filter.

The company-wide audit inspected 1070 student accounts: 1069 active and one archived. Before repair, two accounts had no case:

- STD-1073 / EXP Ana sofia Tobon Pelaez: active, one valid receivable invoice, missing profile/case.
- STD-1069 / Joselin Aburto: archived, no cached transaction evidence. Left unchanged.

The user's explicitly requested repair was applied only to the exact STD-1073/user/invoice UUIDs. The guarded operator command was first previewed read-only, then applied with its SHA-256 fingerprint after local synthetic validation. Writes ran under the normal `sophia_runtime_app` role and tenant context. They created profile 1d4262ad-63c1-42a2-a317-9517736bdc2b and **CASE-1073** (37a2aa59-d8c3-4005-8d6f-47ba539458ce), linked invoice 40fe75e4-f7b1-4551-b0cb-813a6fe9170d / INV-10596, assigned Paulina Aguillon, queued two normal discovery jobs and wrote operator-attributed case/profile audits. The case is Imported — Pending Review / In progress. Imported opening date follows the existing oldest-invoice policy, including future invoice dates.

NEST ACADEMY is not present in the active college directory. The invoice reference was retained; the case college remains unconfirmed and the repair audit marks it for review. No college was invented or unrelated directory entry selected. No login credentials, account status, invoice cache contents or Xero records were modified. Post-commit inspection confirmed the case, profile/advisor and invoice link. The invoice cache update timestamp remained unchanged. A repeated company-wide audit found zero active students without a case; only archived STD-1069 remains.

## Permanent correction

Migration **115_synced_student_case_bootstrap.sql** adds `ensure_synced_student_case(reference,actor)`. The identity worker calls it inside the existing per-candidate transaction, after contact/invoice attribution and before marking the candidate linked. If case bootstrap fails, account creation and attribution roll back to the candidate savepoint. Missing migration 115 produces an actionable pending reason rather than committing another empty account.

The function requires authenticated tenant context, an active student/company mapping and verified ACCREC invoice identities in DRAFT/SUBMITTED/AUTHORISED/PAID. Future invoices are included. It reuses the profile conflict checks, serializes account/profile creation, creates exactly one imported case, links its verified invoices and records audit evidence. A single exact active college match is assigned; unmatched/ambiguous colleges remain for review. Advisor comes from the deterministic latest invoice and current advisor directory. Document discovery is queued locally; no provider request runs in this transaction.

Existing cases of any status—including archived cases—are left alone. The importer does not guess invoice attribution once a case exists and does not recreate deliberately deleted cases. Deleted/voided-only and invoice-free accounts are not given speculative cases. No global backfill or broad production migration was applied during this task.

Deploy migration 115 through the owner runner before redeploying the **identity student-sync worker/legacy backend** with the changed `linkStudent` call. The scoped production data repair is already complete; the permanent prevention code/migration are verified locally and not deployed by this task.

## Verification

- 20 isolated identity-worker PostgreSQL tests passed, including callback invocation, rollback of a new account/invoice mapping when case bootstrap is unavailable, retry after installation, duplicate identities, concurrent imports, authorization and pipeline scheduling.
- Two focused Runtime PostgreSQL tests passed (43 unrelated tests skipped), executing the actual migration function with the non-BYPASSRLS application role. Covered concurrent/idempotent first-case creation, future drafts, exact college/advisor choices, invoice links, discovery jobs, unchanged credentials, cross-tenant refusal, existing/archived case preservation and deliberate-deletion protection.
- Four synthetic operator checks passed: read-only preview, fingerprint refusal before mutation, exact scoped repair with an unconfigured college and idempotent retry without account/invoice changes.
- Runtime TypeScript, JavaScript syntax and diff checks passed.
- Production work was limited to read-only inspection/audit and the explicitly requested single-student repair. No Xero API calls, migration application or worker deployment occurred.

Operator: `scripts/repair-student-import-case.mjs` requires exact customer/user/student/invoice identifiers and number. Default is read-only preview. `--apply` additionally requires `--expected-fingerprint` from the reviewed preview. It refuses changed or ambiguous identities, multiple invoices/cases or ambiguous directory mappings. An unavailable college is explicitly reported and left unconfirmed. Repeated application recognizes an already-repaired case/invoice pair.

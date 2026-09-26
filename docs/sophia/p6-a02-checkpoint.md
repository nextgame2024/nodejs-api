# P6-A02 checkpoint — Evaluations workspace

Completed 25 September 2026.

## Delivered

- ADM-13 is available at `/sophia-admin/evaluations` with structured dataset/case authoring, immutable version approval, deterministic draft runs, failure inspection and publication-policy binding.
- The evaluator reuses the production agent publication-check contract. It does not import or ship the test-only synthetic portability laboratory.
- Dataset cases, evaluator version, target draft/release and configuration digest are pinned in immutable run evidence.
- Required evidence is fail-closed: missing or failed evidence for the exact current draft revision prevents publication. Editing a draft invalidates prior evidence by construction.
- Every delivered run is explicitly `deterministic`, `externalEffects=false` and `meteredSessionCreated=false`. It cannot call providers, connectors, tools, bookings, sends, payments or chargeable sessions.
- Live/provider-judged runs are explicitly unavailable until separate authority, approved data handling and budget controls exist; mocked provider-contract evidence cannot be presented as live.
- Configuration Editor now has `evaluations.read/edit/run`; Release Publisher retains `evaluations.approve` and controls production publication requirements.

## Persistence and Neon verification

- Migration `021_evaluation_control_plane.sql` was applied to the configured Neon database.
- `evaluation_datasets`, `evaluation_dataset_versions`, `agent_evaluation_requirements` and `evaluation_runs` have RLS enabled and forced.
- A rollback-only probe under `sophia_runtime_app` rejected a cross-tenant insert with PostgreSQL `42501`.
- Schema-wide inherited grants were detected and corrected: `sophia_runtime_app` can insert immutable run evidence but cannot update or delete it. A trigger independently rejects owner-side update/delete attempts.

## Verification

- Sophia Runtime: 68 suites, 266 tests passed; TypeScript build passed on Node 22.23.2.
- Angular: type-check passed; 72 Sophia Runtime/Admin tests passed in Chrome Headless 154; production build passed with the existing bundle/font/CommonJS/PrimeIcons warnings.
- Boundary scan: 166 new-product files passed.
- Protected real-estate characterization: 8 suites, 38 tests passed.
- No live provider, external connector, business effect, metered session or commercial charge was invoked.

## Plan refinement

Plan 2.1.27 records that current repository evidence supports deterministic draft/release checks, not honest live-provider comparison. Production fixtures remain quarantined and optional provider-judged evaluation remains a separately gated future capability.

Next ready task: P6-A04 — build the Audit logs explorer and controlled exports.

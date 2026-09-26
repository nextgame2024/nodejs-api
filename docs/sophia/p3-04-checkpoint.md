# P3-04 checkpoint — optional real-estate business pack

Date: 2026-09-24 (Australia/Brisbane)

## Outcome

Real estate is now an explicitly registered compiled business pack rather than a dependency constructed by shared tool orchestration. `SOPHIA_BUSINESS_PACKS=real-estate` preserves the current deployment; `SOPHIA_BUSINESS_PACKS=none` creates a Core-only catalog with no property tools or instructions. Unknown pack IDs fail startup.

The compiled manifest declares the Business Manager connector, enabled shared capability operations, typed schema-extension IDs, UI renderer IDs, tool-catalog version and bounded legacy aliases. It contains no student implementation or dynamic executable configuration.

## Boundary corrections

- Shared `ToolRegistryService`, generic action reviews, provider orchestration and the base Sophia prompt contain no real-estate branch.
- Real-estate client/connector schemas and workflow instructions live under `business-packs/real-estate`.
- Old tool names are created only by the bounded v1 compatibility adapter.
- V1 sessions expose legacy names only; v2 sessions expose canonical capability IDs only. Direct calls using the other naming surface are denied before execution.
- Generic action review types accept only bounded namespaced identifiers; inspection-specific values are owned by the pack.
- The previously missing `PresentationPort`/`ui.dismiss` shared contract is implemented.

## Provider catalog safety

Pre-provisioned Tavus tools are selected using explicit `SOPHIA_PROVIDER_CATALOG_MODE=legacy|canonical`. Composite session opening hashes its exact tool definitions and compares them with the active deployment. A stale or opposite-mode catalog fails before remote conversation creation. This keeps a tenant cutover explicit and prevents mixed legacy/canonical names.

## Verification

- Core-only registry boots with the generic research tool, no pack manifest, `core-tools-v1`, and no property instructions.
- Compiled-pack tests validate connector/capability/extension/renderer/alias declarations and student exclusion.
- Sophia Runtime typecheck/build: pass.
- Sophia Runtime full suite: 46 suites, 182 tests passed.
- Protected real-estate suite: 7 suites, 32 tests passed.
- Contract suite: 15 tests passed.
- Boundary scan: 98 new-product files passed, including a new generic-tool-core rule.
- Backend release suite: 16 suites and 66 tests passed; 12 existing SQL-gated tests skipped.

## Compatibility limit

The existing Angular kiosk still renders the legacy real-estate response shapes inside its current page. The compiled pack now declares stable renderer IDs, but moving the page orchestration/renderers behind the v2 session facade belongs to P4-01 and must preserve the visible journeys. This does not put business policy back into Runtime Core.

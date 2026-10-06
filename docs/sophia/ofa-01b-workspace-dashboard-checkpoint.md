# OFA-01B checkpoint — Workspace profile and dashboard shell

Date: 6 October 2026
Decision: complete in source; migration and profile selection remain deployment actions

## Outcome

`bm_company.workspace_profile` is an extensible string discriminator with two
initial values: `project_map` and `student_operations`. Existing and future
companies default to `project_map`, preserving the real-estate workspace. Only
the platform Super Admin may set the field; customer company edits cannot mutate
it.

On `/manager/menu`, `student_operations` renders the Open For Australia
Operations Dashboard and does not initialize Google Maps. The initial shell
shows only values supported by the current student read model. Financial metrics
are explicitly unavailable until Payments & Controls exists.

## Deployment action

Apply `scripts/sql/bm_company_workspace_profile.sql`, then use the Super Admin
Company screen to select `Student operations` for OPEN 4 & CO PTY LTD. No
production migration was applied by this checkpoint.

## Evidence

- Backend release suite: 19 suites passed, 70 tests passed, 4 skipped.
- Boundary gate: passed, 256 files scanned.
- Real-estate regression: 8 suites and 38 tests passed.
- Focused Angular OFA/role tests: 6 passed.
- Angular typecheck and production build: passed.


# Retired student-agency demo boundary

Status: source retired on 5 October 2026.

The former student-agency demonstration implemented migration-rule guidance,
rule comparison, consultation booking, consultation email delivery and related
demo UI. It was not the Student Operations operations product and is no longer
part of any executable product path.

## Removed executable surface

- Express student-agency routes, services, models and startup schema creation.
- Consultation delivery workers from both the API process and background cron.
- Demo content, setup/import/release scripts and student-specific tests.
- Retired Nest student-agency tools and their Business Manager transport.
- Retired Angular guidance/consultation panels and kiosk tests.

The real-estate demonstration and its route, workers, characterization tests and
Angular presentation remain unchanged.

## Database disposition

The configured database was explicitly retired without backup on 5 October 2026.
Six `public.bm_student_*` tables and their 96 historical rows were permanently
deleted in dependency order using
`scripts/sql/drop_retired_student_agency_demo.sql`. The operation deliberately
avoided `CASCADE`; its only foreign-key dependencies were internal to the six
tables. A post-operation catalogue query returned zero matching tables.

## New Student Operations boundary

Any future Student Operations implementation is a new business pack, not a
revival or rename of this demo. It must use a new domain model, tenant-scoped
authorization, privacy controls, auditable workflow state and protected document
storage. Generic platform primitives may be reused; demo-specific schema and
semantics must not be copied.

The source boundary checker continues to reject retired student-agency,
migration-guidance and consultation-demo dependencies in Sophia core, Admin,
capability, connector and business-pack code.

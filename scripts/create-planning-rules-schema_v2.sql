-- create-planning-rules-schema_v2.sql
--
-- Purpose:
--   Provide a place to store NON-spatial planning controls extracted from
--   Brisbane City Plan 2014 (and subsequent scheme versions), e.g.
--   - maximum building height (where not map-driven)
--   - minimum lot size / frontage
--   - multiple dwelling thresholds
--   - plot ratio, site cover, setbacks (where stated as numeric controls)
--
-- This is intentionally generic and JSON-friendly so you can iteratively
-- enrich it without expensive schema migrations.

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS bcc_planning_controls_v2 (
  id bigserial PRIMARY KEY,
  scheme_version text NOT NULL,       -- e.g. 'v34.00-2025'
  jurisdiction text NOT NULL DEFAULT 'Brisbane City Council',

  -- Identifiers that allow the application to join controls to a lot
  zone_code text,                     -- e.g. 'LDR', 'LMR'
  zone_name text,
  neighbourhood_plan text,
  precinct_code text,
  overlay_code text,

  -- A human-readable label for the control set
  label text NOT NULL,

  -- Structured controls (units should be explicit in values)
  controls jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Traceability / audit
  source_url text,
  source_citation text,               -- clause/code reference, page, etc.
  extracted_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (scheme_version, label, zone_code, neighbourhood_plan, precinct_code, overlay_code)
);

-- Useful indexes
CREATE INDEX IF NOT EXISTS bcc_planning_controls_v2_zone_idx ON bcc_planning_controls_v2(zone_code);
CREATE INDEX IF NOT EXISTS bcc_planning_controls_v2_np_idx ON bcc_planning_controls_v2(neighbourhood_plan);
CREATE INDEX IF NOT EXISTS bcc_planning_controls_v2_precinct_idx ON bcc_planning_controls_v2(precinct_code);
CREATE INDEX IF NOT EXISTS bcc_planning_controls_v2_controls_gin ON bcc_planning_controls_v2 USING GIN (controls);

-- Add city-level property search without conflating cities and suburbs.
ALTER TABLE bm_properties
  ADD COLUMN IF NOT EXISTS city text;

UPDATE bm_properties
SET city = 'Brisbane'
WHERE city IS NULL OR btrim(city) = '';

ALTER TABLE bm_properties
  ALTER COLUMN city SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bm_properties_location_search
  ON bm_properties(company_id, listing_type, status, city, suburb);

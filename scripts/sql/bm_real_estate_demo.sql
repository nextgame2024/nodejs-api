-- Real-estate demo data owned by Business Manager.
CREATE TABLE IF NOT EXISTS bm_properties (
  property_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES bm_company(company_id) ON DELETE CASCADE,
  listing_type text NOT NULL CHECK (listing_type IN ('sale','rent')),
  property_type text NOT NULL,
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available','under_offer','leased','sold','archived')),
  title text NOT NULL,
  address text NOT NULL,
  suburb text NOT NULL,
  state text NOT NULL DEFAULT 'QLD', postcode text NOT NULL,
  latitude numeric(9,6), longitude numeric(9,6),
  price_display text NOT NULL, price_amount numeric(12,2),
  bedrooms smallint NOT NULL, bathrooms smallint NOT NULL, car_spaces smallint NOT NULL DEFAULT 0,
  description text NOT NULL, features jsonb NOT NULL DEFAULT '[]'::jsonb,
  agent_name text, agent_email text, agent_phone text,
  createdat timestamptz NOT NULL DEFAULT now(), updatedat timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bm_properties_search ON bm_properties(company_id, listing_type, status, suburb);

CREATE TABLE IF NOT EXISTS bm_property_media (
  media_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES bm_properties(property_id) ON DELETE CASCADE,
  object_key text, media_url text NOT NULL, alt_text text, sort_order integer NOT NULL DEFAULT 0,
  createdat timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bm_property_media_property ON bm_property_media(property_id, sort_order);

CREATE TABLE IF NOT EXISTS bm_property_inspection_slots (
  slot_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES bm_properties(property_id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, capacity integer NOT NULL DEFAULT 10,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','cancelled')),
  CHECK (starts_at < ends_at)
);
CREATE INDEX IF NOT EXISTS idx_bm_inspection_slots_property_time ON bm_property_inspection_slots(property_id, starts_at);

CREATE TABLE IF NOT EXISTS bm_property_inspection_bookings (
  booking_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES bm_company(company_id) ON DELETE CASCADE,
  property_id uuid NOT NULL REFERENCES bm_properties(property_id) ON DELETE CASCADE,
  slot_id uuid NOT NULL REFERENCES bm_property_inspection_slots(slot_id) ON DELETE RESTRICT,
  customer_name text NOT NULL, customer_email text NOT NULL, customer_phone text,
  idempotency_key text NOT NULL, status text NOT NULL DEFAULT 'confirmed',
  createdat timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id, idempotency_key), UNIQUE(slot_id, customer_email)
);

CREATE TABLE IF NOT EXISTS bm_agency_knowledge (
  knowledge_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES bm_company(company_id) ON DELETE CASCADE,
  category text NOT NULL, question text NOT NULL, answer text NOT NULL,
  source_url text, jurisdiction text, reviewed_at date, active boolean NOT NULL DEFAULT true,
  createdat timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bm_agency_knowledge_company ON bm_agency_knowledge(company_id, active, category);

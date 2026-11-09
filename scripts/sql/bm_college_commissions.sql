BEGIN;
ALTER TABLE bm_colleges ADD COLUMN IF NOT EXISTS acronym text
  CHECK (acronym IS NULL OR length(btrim(acronym)) BETWEEN 1 AND 80);

CREATE TABLE IF NOT EXISTS bm_college_commission_imports (
  import_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES bm_company(company_id),
  source_sha256 text NOT NULL,
  source_records jsonb NOT NULL,
  createdat timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, source_sha256),
  UNIQUE (company_id, import_id)
);

CREATE TABLE IF NOT EXISTS bm_college_commission_rules (
  rule_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  college_id uuid NOT NULL,
  classification text CHECK (classification IN ('ELICOS','VET','HE')),
  location text CHECK (location IN ('ON-SHORE','OFF-SHORE')),
  program text CHECK (program IS NULL OR length(btrim(program)) BETWEEN 1 AND 300),
  commission_basis_points integer NOT NULL CHECK (commission_basis_points BETWEEN 0 AND 10000),
  calculation_method text NOT NULL DEFAULT 'tuition_fee_percentage' CHECK (calculation_method = 'tuition_fee_percentage'),
  calculation_description text NOT NULL,
  rounding_decimal_places integer NOT NULL DEFAULT 2 CHECK (rounding_decimal_places = 2),
  cashback_status text NOT NULL CHECK (cashback_status IN ('not_recorded','not_applicable','specified')),
  cashback_description text,
  cashback_calculation_description text,
  cashback_calculation numeric(14,2) CHECK (cashback_calculation >= 0 AND cashback_calculation < 1000000000000),
  bonus_status text NOT NULL CHECK (bonus_status IN ('not_recorded','not_applicable','specified')),
  bonus_description text,
  bonus_amount numeric(14,2) CHECK (bonus_amount >= 0 AND bonus_amount < 1000000000000),
  application_conditions text,
  active boolean NOT NULL DEFAULT true,
  import_id uuid,
  source_rows integer[],
  createdat timestamptz NOT NULL DEFAULT now(),
  updatedat timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id,college_id) REFERENCES bm_colleges(company_id,college_id),
  FOREIGN KEY (company_id,import_id) REFERENCES bm_college_commission_imports(company_id,import_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS bm_college_commission_rules_conditions
  ON bm_college_commission_rules(company_id,college_id,coalesce(classification,''),coalesce(location,''),lower(coalesce(program,'')))
  WHERE active;
CREATE INDEX IF NOT EXISTS bm_college_commission_rules_parent ON bm_college_commission_rules(company_id,college_id,active);
COMMENT ON COLUMN bm_college_commission_rules.commission_basis_points IS '100 = 1%; 3182 = 31.82%. No invoice amount calculated here.';
COMMENT ON TABLE bm_college_commission_rules IS 'NULL conditions are unrestricted. All populated conditions must match. Most specific matching rule wins; equal-specificity ambiguity requires review. No match is not a zero rate.';
COMMIT;

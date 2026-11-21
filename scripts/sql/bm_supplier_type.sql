-- Preserve material access for existing product suppliers. New suppliers
-- default to Services. Re-running this migration preserves explicit choices.
BEGIN;
ALTER TABLE bm_suppliers ADD COLUMN IF NOT EXISTS supplier_type text;
UPDATE bm_suppliers s SET supplier_type = CASE WHEN
  EXISTS (SELECT 1 FROM bm_supplier_materials m WHERE m.company_id=s.company_id AND m.supplier_id=s.supplier_id)
  OR EXISTS (SELECT 1 FROM bm_project_types_materials m WHERE m.company_id=s.company_id AND m.supplier_id=s.supplier_id)
  OR EXISTS (SELECT 1 FROM bm_project_materials m WHERE m.company_id=s.company_id AND m.supplier_id=s.supplier_id)
  THEN 'products' ELSE 'services' END
WHERE supplier_type IS NULL;
ALTER TABLE bm_suppliers ALTER COLUMN supplier_type SET DEFAULT 'services';
ALTER TABLE bm_suppliers ALTER COLUMN supplier_type SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='bm_suppliers'::regclass AND conname='bm_suppliers_type_check') THEN
    ALTER TABLE bm_suppliers ADD CONSTRAINT bm_suppliers_type_check CHECK (supplier_type IN ('services', 'products'));
  END IF;
END $$;
COMMIT;

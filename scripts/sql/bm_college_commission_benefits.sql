BEGIN;
ALTER TABLE bm_college_commission_rules
  ADD COLUMN IF NOT EXISTS cashback_calculation numeric(14,2)
    CHECK (cashback_calculation >= 0 AND cashback_calculation < 1000000000000),
  ADD COLUMN IF NOT EXISTS bonus_amount numeric(14,2)
    CHECK (bonus_amount >= 0 AND bonus_amount < 1000000000000);
COMMENT ON COLUMN bm_college_commission_rules.cashback_calculation IS 'User-entered decimal value. NULL is unspecified; 0.00 is explicit. Interpretation is reserved for the invoice workflow.';
COMMENT ON COLUMN bm_college_commission_rules.bonus_amount IS 'User-entered decimal value. NULL is unspecified; 0.00 is explicit.';
COMMIT;

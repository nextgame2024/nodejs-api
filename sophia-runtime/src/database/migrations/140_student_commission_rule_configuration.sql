-- Additive v2 configuration. Old rows/snapshots continue to use their legacy contract.
ALTER TABLE public.bm_college_commission_rules
 ADD COLUMN IF NOT EXISTS configuration jsonb,
 ADD COLUMN IF NOT EXISTS changed_by text;
ALTER TABLE public.bm_college_commission_rules ADD CONSTRAINT bm_commission_configuration_version
 CHECK(configuration IS NULL OR (jsonb_typeof(configuration)='object' AND configuration->>'version'='2' AND configuration->>'state' IN ('ready','blocked')));
DROP INDEX IF EXISTS public.bm_college_commission_rules_conditions;
CREATE UNIQUE INDEX bm_college_commission_rules_conditions ON public.bm_college_commission_rules
 (company_id,college_id,coalesce(classification,''),coalesce(location,''),lower(coalesce(program,'')),
 lower(coalesce(configuration->>'city','')),coalesce(configuration->>'effectiveFrom',''),coalesce(configuration->>'effectiveTo','')) WHERE active;
COMMENT ON COLUMN public.bm_college_commission_rules.configuration IS 'Versioned declarative rules. Rate is an exact rational; blocked rules must never fall through to a general rate. Effective dates use original enrolment. Source prose is not executed.';
CREATE OR REPLACE VIEW __SOPHIA_RUNTIME_SCHEMA__.student_college_commission_rules WITH (security_barrier=true) AS
 SELECT c.customer_id,r.rule_id,r.college_id,r.classification,r.location,r.program,
 r.commission_basis_points,r.calculation_method,r.rounding_decimal_places,r.cashback_status,r.bonus_status,
 r.application_conditions,r.active,r.createdat,r.updatedat,r.configuration
 FROM __SOPHIA_RUNTIME_SCHEMA__.customers c JOIN public.bm_college_commission_rules r ON r.company_id::text=c.external_company_id
 WHERE c.status='active' AND c.customer_id=NULLIF(current_setting('sophia.tenant_id',true),'')::uuid;
REVOKE ALL ON __SOPHIA_RUNTIME_SCHEMA__.student_college_commission_rules FROM PUBLIC;
GRANT SELECT ON __SOPHIA_RUNTIME_SCHEMA__.student_college_commission_rules TO sophia_runtime_app;

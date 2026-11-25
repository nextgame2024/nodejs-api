-- Distinct named workbook contracts may share predicates; invoice selection resolves them.
DROP INDEX IF EXISTS public.bm_college_commission_rules_conditions;
CREATE UNIQUE INDEX bm_college_commission_rules_conditions ON public.bm_college_commission_rules
 (company_id,college_id,coalesce(classification,''),coalesce(location,''),lower(coalesce(program,'')),
 lower(coalesce(configuration->>'city','')),coalesce(configuration->>'effectiveFrom',''),coalesce(configuration->>'effectiveTo',''),
 lower(coalesce(configuration->>'label',''))) WHERE active;

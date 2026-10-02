BEGIN;

INSERT INTO sophia_runtime.customers (
  customer_id,name,external_company_id,status,metadata
) VALUES (
  'faa7c7c6-9193-4fb4-825c-8c52a74a2986',
  'C4B Founding Full Lifecycle Proof 2',
  'faa7c7c6-9193-4fb4-825c-8c52a74a2986',
  'active',
  '{"syntheticFoundingProof":true}'::jsonb
) ON CONFLICT (customer_id) DO NOTHING;

INSERT INTO sophia_runtime.tenant_commercial_assignments (
  customer_id,commercial_plan_version_id,status,effective_from,assigned_by_identity,assignment_reason
)
SELECT
  'faa7c7c6-9193-4fb4-825c-8c52a74a2986',
  plan.commercial_plan_version_id,
  'active',
  now(),
  'operator:founding-sandbox-proof',
  'Isolated P6-A06C3B0D4 Stripe sandbox full-lifecycle proof'
FROM sophia_runtime.commercial_plan_versions plan
WHERE plan.plan_key='sophia-essential-founding' AND plan.version=1 AND plan.status='published'
  AND NOT EXISTS (
    SELECT 1 FROM sophia_runtime.tenant_commercial_assignments assignment
    WHERE assignment.customer_id='faa7c7c6-9193-4fb4-825c-8c52a74a2986'
  );

DO $proof$
BEGIN
  IF (SELECT count(*) FROM sophia_runtime.tenant_commercial_assignments
      WHERE customer_id='faa7c7c6-9193-4fb4-825c-8c52a74a2986' AND status='active') <> 1 THEN
    RAISE EXCEPTION 'Founding proof tenant must have exactly one active commercial assignment';
  END IF;
END
$proof$;

COMMIT;

SELECT customer.customer_id,customer.name,plan.commercial_plan_version_id,plan.display_name,
       plan.minimum_commitment_months,plan.rate_card
FROM sophia_runtime.customers customer
JOIN sophia_runtime.tenant_commercial_assignments assignment
  ON assignment.customer_id=customer.customer_id AND assignment.status='active'
JOIN sophia_runtime.commercial_plan_versions plan
  ON plan.commercial_plan_version_id=assignment.commercial_plan_version_id
WHERE customer.customer_id='faa7c7c6-9193-4fb4-825c-8c52a74a2986';

import { createHash } from "node:crypto";
import { Client } from "pg";

const CONFIRMATION = "I_UNDERSTAND_THIS_PUBLISHES_A_COMMERCIAL_PLAN";
const connectionString = process.env.SOPHIA_RUNTIME_DATABASE_URL;
const schema = process.env.SOPHIA_RUNTIME_SCHEMA ?? "sophia_runtime";
const providerAccountKey = process.env.SOPHIA_BILLING_PROVIDER_ACCOUNT_KEY ?? "legacy-primary";

if (!connectionString) throw new Error("SOPHIA_RUNTIME_DATABASE_URL is required.");
if (process.env.SOPHIA_FOUNDING_CATALOG_CONFIRM !== CONFIRMATION) {
  throw new Error(`Set SOPHIA_FOUNDING_CATALOG_CONFIRM=${CONFIRMATION}.`);
}
if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) throw new Error("SOPHIA_RUNTIME_SCHEMA is invalid.");
if (!/^[a-z][a-z0-9-]{1,79}$/.test(providerAccountKey)) {
  throw new Error("SOPHIA_BILLING_PROVIDER_ACCOUNT_KEY is invalid.");
}

const plan = {
  planKey: "sophia-essential-founding",
  version: 1,
  displayName: "Sophia Essential Founding",
  baseChargeMinor: "19000",
  overageRateMinor: "10",
  concurrentSessions: 3,
  toolCallsPerMinute: 15,
  includedActiveSeconds: "60000",
  minimumCommitmentMonths: 12,
  chargeComponents: [
    { componentKey: "commencement", chargeTiming: "initial_checkout", milestoneKey: null,
      amountMinor: "95000", currency: "AUD",
      description: "Implementation and onboarding — commencement" },
    { componentKey: "production-deployment", chargeTiming: "operator_milestone",
      milestoneKey: "production-deployment", amountMinor: "95000", currency: "AUD",
      description: "Implementation and onboarding — production deployment accepted" },
  ],
} as const;

const rateCard = { dimensions: [{ dimension: "active-seconds",
  includedQuantity: plan.includedActiveSeconds, unitQuantity: "60", unitPriceMinor: plan.overageRateMinor }] };
const entitlements = { concurrentSessions: plan.concurrentSessions, toolCallsPerMinute: plan.toolCallsPerMinute };

const client = new Client({ connectionString, ssl: { rejectUnauthorized: true } });
await client.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `commercial-plan:${plan.planKey}:${plan.version}`,
  ]);
  const authority = await client.query<{ seller_legal_entity_id: string; seller_key: string }>(
    `SELECT seller.seller_legal_entity_id,seller.seller_key
     FROM ${schema}.seller_legal_entities seller
     JOIN ${schema}.seller_billing_provider_accounts account
       ON account.seller_legal_entity_id=seller.seller_legal_entity_id
     WHERE seller.status='active' AND account.status='active'
       AND account.provider_key='stripe-sophia' AND account.provider_environment='sandbox'
       AND account.provider_account_key=$1`, [providerAccountKey]);
  if (authority.rows.length !== 1) {
    throw new Error("The configured sandbox provider account must resolve to exactly one active seller.");
  }
  const seller = authority.rows[0];
  const manifest = { planKey: plan.planKey, version: plan.version, displayName: plan.displayName,
    billingCurrency: "AUD", billingInterval: "month", baseChargeMinor: plan.baseChargeMinor,
    taxMode: "not_applicable", taxCategory: "standard_rate", overageRounding: "ceil",
    rateCard, entitlements, sellerKey: seller.seller_key,
    minimumCommitmentMonths: plan.minimumCommitmentMonths, chargeComponents: plan.chargeComponents };
  const digest = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  const existing = await client.query<{ commercial_plan_version_id: string; manifest_digest: string;
    minimum_commitment_months: number | null; status: string }>(
    `SELECT commercial_plan_version_id,manifest_digest,minimum_commitment_months,status
     FROM ${schema}.commercial_plan_versions WHERE plan_key=$1 AND version=$2`,
    [plan.planKey, plan.version]);
  if (existing.rows.length > 1) throw new Error("The Founding commercial plan identity is ambiguous.");
  let planVersionId: string;
  let result: "published" | "existing";
  if (!existing.rows[0]) {
    const inserted = await client.query<{ commercial_plan_version_id: string }>(
      `INSERT INTO ${schema}.commercial_plan_versions(
         plan_key,version,display_name,status,pricing_status,billing_currency,billing_interval,base_charge_minor,
         tax_mode,overage_rounding,rate_card,entitlements,manifest_digest,published_at,seller_legal_entity_id,
         tax_category,minimum_commitment_months)
       VALUES($1,$2,$3,'draft','configured','AUD','month',$4,'not_applicable','ceil',$5::jsonb,$6::jsonb,$7,NULL,$8,
         'standard_rate',$9)
       RETURNING commercial_plan_version_id`,
      [plan.planKey, plan.version, plan.displayName, plan.baseChargeMinor, JSON.stringify(rateCard),
        JSON.stringify(entitlements), digest, seller.seller_legal_entity_id, plan.minimumCommitmentMonths]);
    planVersionId = inserted.rows[0].commercial_plan_version_id;
    for (const component of plan.chargeComponents) {
      await client.query(
        `INSERT INTO ${schema}.commercial_plan_charge_components(
           commercial_plan_version_id,component_key,charge_timing,milestone_key,amount_minor,currency,description)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [planVersionId, component.componentKey, component.chargeTiming, component.milestoneKey,
          component.amountMinor, component.currency, component.description]);
    }
    await client.query(
      `UPDATE ${schema}.commercial_plan_versions SET status='published',published_at=now()
       WHERE commercial_plan_version_id=$1 AND status='draft'`, [planVersionId]);
    result = "published";
  } else {
    const row = existing.rows[0];
    if (row.status !== "published" || row.manifest_digest !== digest
      || row.minimum_commitment_months !== plan.minimumCommitmentMonths) {
      throw new Error("The existing Founding plan differs from the approved immutable definition.");
    }
    planVersionId = row.commercial_plan_version_id;
    result = "existing";
  }
  const components = await client.query<{ component_key: string; charge_timing: string;
    milestone_key: string | null; amount_minor: string; currency: string; description: string }>(
    `SELECT component_key,charge_timing,milestone_key,amount_minor::text,currency,description
     FROM ${schema}.commercial_plan_charge_components WHERE commercial_plan_version_id=$1
     ORDER BY component_key`, [planVersionId]);
  const expectedComponents = plan.chargeComponents.map((component) => ({ component_key: component.componentKey,
    charge_timing: component.chargeTiming, milestone_key: component.milestoneKey,
    amount_minor: component.amountMinor, currency: component.currency, description: component.description }))
    .sort((left, right) => left.component_key.localeCompare(right.component_key));
  if (JSON.stringify(components.rows) !== JSON.stringify(expectedComponents)) {
    throw new Error("The stored Founding charge components differ from the approved immutable definition.");
  }
  await client.query("COMMIT");
  process.stdout.write(`${JSON.stringify({ stage: "founding_commercial_plan_ready", result,
    planKey: plan.planKey, version: plan.version, planVersionId, providerAccountKey,
    minimumCommitmentMonths: plan.minimumCommitmentMonths, includedActiveSeconds: plan.includedActiveSeconds,
    liveMutation: false }, null, 2)}\n`);
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}

import { createHash } from "node:crypto";
import { Client } from "pg";
import { z } from "zod";

const chargeComponentSchema = z.object({
  componentKey: z.string().regex(/^[a-z][a-z0-9-]{1,79}$/),
  chargeTiming: z.enum(["initial_checkout", "operator_milestone"]),
  milestoneKey: z.string().regex(/^[a-z][a-z0-9-]{1,79}$/).nullable(),
  amountMinor: z.string().regex(/^[1-9]\d*$/),
  currency: z.literal("AUD"),
  description: z.string().min(1).max(240),
}).strict().superRefine((component, context) => {
  if ((component.chargeTiming === "initial_checkout") !== (component.milestoneKey === null)) {
    context.addIssue({ code: "custom", message: "Only operator milestones may declare a milestone key." });
  }
});

const planSchema = z.object({
  planKey: z.string().regex(/^[a-z][a-z0-9-]{1,79}$/),
  version: z.number().int().positive(),
  displayName: z.string().min(1).max(160),
  baseChargeMinor: z.string().regex(/^\d+$/),
  overageRateMinor: z.string().regex(/^\d+$/),
  concurrentSessions: z.number().int().positive(),
  toolCallsPerMinute: z.number().int().positive(),
  includedActiveSeconds: z.string().regex(/^[1-9]\d*$/).optional(),
  minimumCommitmentMonths: z.number().int().min(1).max(120).nullable().optional(),
  chargeComponents: z.array(chargeComponentSchema).max(10).optional(),
}).strict();

const catalogSchema = z.object({
  sellerKey: z.string().regex(/^[a-z][a-z0-9-]{1,79}$/),
  legalName: z.string().min(1).max(240),
  tradingName: z.string().min(1).max(240).nullable().default(null),
  abn: z.string().regex(/^\d{11}$/),
  effectiveFrom: z.string().datetime({ offset: true }),
  providerAccount: z.object({
    providerKey: z.literal("stripe-sophia"),
    environment: z.enum(["sandbox", "live"]),
    accountKey: z.string().regex(/^[a-z][a-z0-9-]{1,79}$/),
    externalAccountRef: z.string().regex(/^acct_[A-Za-z0-9]{8,}$/),
  }).strict(),
  plans: z.array(planSchema).min(1),
}).strict();

const connectionString = process.env.SOPHIA_RUNTIME_DATABASE_URL;
const schema = process.env.SOPHIA_RUNTIME_SCHEMA ?? "sophia_runtime";
const rawCatalog = process.env.SOPHIA_COMMERCIAL_CATALOG_JSON;
if (!connectionString) throw new Error("SOPHIA_RUNTIME_DATABASE_URL is required.");
if (!rawCatalog) throw new Error("SOPHIA_COMMERCIAL_CATALOG_JSON is required.");
if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) throw new Error("SOPHIA_RUNTIME_SCHEMA is invalid.");
const catalog = catalogSchema.parse(JSON.parse(rawCatalog));
if (new Set(catalog.plans.map((plan) => `${plan.planKey}:${plan.version}`)).size !== catalog.plans.length) {
  throw new Error("Commercial catalog contains duplicate plan versions.");
}

const client = new Client({ connectionString, ssl: { rejectUnauthorized: true } });
await client.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`commercial-catalog:${catalog.sellerKey}`]);

  const seller = await client.query<{ seller_legal_entity_id: string }>(
    `INSERT INTO ${schema}.seller_legal_entities(seller_key,status) VALUES($1,'active')
     ON CONFLICT (seller_key) DO UPDATE SET seller_key=EXCLUDED.seller_key
     RETURNING seller_legal_entity_id`, [catalog.sellerKey]);
  const sellerId = seller.rows[0].seller_legal_entity_id;

  const legal = await client.query<{ seller_legal_entity_version_id: string; legal_name: string; registration_identifier_value: string }>(
    `SELECT seller_legal_entity_version_id,legal_name,registration_identifier_value
     FROM ${schema}.seller_legal_entity_versions WHERE seller_legal_entity_id=$1 AND version=1`, [sellerId]);
  let legalVersionId: string;
  if (legal.rows[0]) {
    if (legal.rows[0].legal_name !== catalog.legalName || legal.rows[0].registration_identifier_value !== catalog.abn) {
      throw new Error("Published seller legal version 1 differs from the requested immutable identity.");
    }
    legalVersionId = legal.rows[0].seller_legal_entity_version_id;
  } else {
    const inserted = await client.query<{ seller_legal_entity_version_id: string }>(
      `INSERT INTO ${schema}.seller_legal_entity_versions(
         seller_legal_entity_id,version,status,legal_form,jurisdiction_country,legal_name,trading_name,
         registration_identifier_type,registration_identifier_value,effective_from,published_at)
       VALUES($1,1,'published','sole_trader','AU',$2,$3,'ABN',$4,$5,$5)
       RETURNING seller_legal_entity_version_id`,
      [sellerId, catalog.legalName, catalog.tradingName, catalog.abn, catalog.effectiveFrom]);
    legalVersionId = inserted.rows[0].seller_legal_entity_version_id;
  }

  const policy = await client.query<{ seller_commercial_policy_version_id: string }>(
    `SELECT seller_commercial_policy_version_id FROM ${schema}.seller_commercial_policy_versions
     WHERE seller_legal_entity_id=$1 AND version=1`, [sellerId]);
  let policyVersionId = policy.rows[0]?.seller_commercial_policy_version_id;
  if (!policyVersionId) {
    const inserted = await client.query<{ seller_commercial_policy_version_id: string }>(
      `INSERT INTO ${schema}.seller_commercial_policy_versions(
         seller_legal_entity_id,seller_legal_entity_version_id,version,status,customer_scope,gst_registered,
         tax_jurisdiction_country,tax_calculation_mode,price_display_mode,effective_from,published_at)
       VALUES($1,$2,1,'published','business_only',false,'AU','none','no_tax',$3,$3)
       RETURNING seller_commercial_policy_version_id`, [sellerId, legalVersionId, catalog.effectiveFrom]);
    policyVersionId = inserted.rows[0].seller_commercial_policy_version_id;
  }

  await client.query(
    `INSERT INTO ${schema}.seller_billing_provider_accounts(
       seller_legal_entity_id,provider_key,provider_environment,provider_account_key,external_account_ref,status,effective_from)
     VALUES($1,$2,$3,$4,$5,'active',$6)
     ON CONFLICT (provider_key,provider_environment,provider_account_key) DO NOTHING`,
    [sellerId, catalog.providerAccount.providerKey, catalog.providerAccount.environment,
      catalog.providerAccount.accountKey, catalog.providerAccount.externalAccountRef, catalog.effectiveFrom]);
  const account = await client.query<{ external_account_ref: string; seller_legal_entity_id: string }>(
    `SELECT external_account_ref,seller_legal_entity_id FROM ${schema}.seller_billing_provider_accounts
     WHERE provider_key=$1 AND provider_environment=$2 AND provider_account_key=$3`,
    [catalog.providerAccount.providerKey, catalog.providerAccount.environment, catalog.providerAccount.accountKey]);
  if (account.rows[0]?.external_account_ref !== catalog.providerAccount.externalAccountRef
    || account.rows[0]?.seller_legal_entity_id !== sellerId) {
    throw new Error("Provider-account key already belongs to a different immutable seller/account identity.");
  }

  const published: Array<{ planKey: string; version: number; planVersionId: string }> = [];
  for (const plan of catalog.plans) {
    const components = plan.chargeComponents ?? [];
    if (new Set(components.map((component) => component.componentKey)).size !== components.length) {
      throw new Error(`Commercial plan ${plan.planKey} v${plan.version} contains duplicate charge-component keys.`);
    }
    const rateCard = { dimensions: [{ dimension: "active-seconds",
      includedQuantity: plan.includedActiveSeconds ?? "120000",
      unitQuantity: "60", unitPriceMinor: plan.overageRateMinor }] };
    const entitlements = { concurrentSessions: plan.concurrentSessions, toolCallsPerMinute: plan.toolCallsPerMinute };
    const manifest = { planKey: plan.planKey, version: plan.version, displayName: plan.displayName,
      billingCurrency: "AUD", billingInterval: "month", baseChargeMinor: plan.baseChargeMinor,
      taxMode: "not_applicable", taxCategory: "standard_rate", overageRounding: "ceil",
      rateCard, entitlements, sellerKey: catalog.sellerKey,
      ...((plan.minimumCommitmentMonths !== undefined || plan.includedActiveSeconds !== undefined
        || plan.chargeComponents !== undefined) ? {
          minimumCommitmentMonths: plan.minimumCommitmentMonths ?? null,
          chargeComponents: components,
        } : {}),
    };
    const digest = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
    const existing = await client.query<{ commercial_plan_version_id: string; manifest_digest: string;
      minimum_commitment_months: number | null; status: string }>(
      `SELECT commercial_plan_version_id,manifest_digest,minimum_commitment_months,status
       FROM ${schema}.commercial_plan_versions
       WHERE plan_key=$1 AND version=$2`, [plan.planKey, plan.version]);
    if (existing.rows[0] && existing.rows[0].manifest_digest !== digest) {
      throw new Error(`Published plan ${plan.planKey} v${plan.version} differs from the requested immutable manifest.`);
    }
    const inserted = existing.rows[0] ?? (await client.query<{ commercial_plan_version_id: string; manifest_digest: string }>(
      `INSERT INTO ${schema}.commercial_plan_versions(
         plan_key,version,display_name,status,pricing_status,billing_currency,billing_interval,base_charge_minor,
         tax_mode,overage_rounding,rate_card,entitlements,manifest_digest,published_at,seller_legal_entity_id,
         tax_category,minimum_commitment_months)
       VALUES($1,$2,$3,'draft','configured','AUD','month',$4,'not_applicable','ceil',$5::jsonb,$6::jsonb,$7,NULL,$8,
         'standard_rate',$9)
       RETURNING commercial_plan_version_id,manifest_digest`,
      [plan.planKey, plan.version, plan.displayName, plan.baseChargeMinor, JSON.stringify(rateCard),
        JSON.stringify(entitlements), digest, sellerId, plan.minimumCommitmentMonths ?? null])).rows[0];
    const planVersionId = inserted.commercial_plan_version_id;
    if (!existing.rows[0]) {
      for (const component of components) {
        await client.query(
          `INSERT INTO ${schema}.commercial_plan_charge_components(
             commercial_plan_version_id,component_key,charge_timing,milestone_key,amount_minor,currency,description)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [planVersionId, component.componentKey, component.chargeTiming, component.milestoneKey,
            component.amountMinor, component.currency, component.description]);
      }
      await client.query(
        `UPDATE ${schema}.commercial_plan_versions SET status='published',published_at=$2
         WHERE commercial_plan_version_id=$1 AND status='draft'`, [planVersionId, catalog.effectiveFrom]);
    } else {
      if (existing.rows[0].status !== "published"
        || existing.rows[0].minimum_commitment_months !== (plan.minimumCommitmentMonths ?? null)) {
        throw new Error(`Commercial plan ${plan.planKey} v${plan.version} has inconsistent published commitment state.`);
      }
      const storedComponents = await client.query<{
        component_key: string; charge_timing: string; milestone_key: string | null;
        amount_minor: string; currency: string; description: string;
      }>(`SELECT component_key,charge_timing,milestone_key,amount_minor::text,currency,description
           FROM ${schema}.commercial_plan_charge_components WHERE commercial_plan_version_id=$1
           ORDER BY component_key`, [planVersionId]);
      const expectedComponents = components.map((component) => ({ component_key: component.componentKey,
        charge_timing: component.chargeTiming, milestone_key: component.milestoneKey,
        amount_minor: component.amountMinor, currency: component.currency, description: component.description }))
        .sort((left, right) => left.component_key.localeCompare(right.component_key));
      if (JSON.stringify(storedComponents.rows) !== JSON.stringify(expectedComponents)) {
        throw new Error(`Commercial plan ${plan.planKey} v${plan.version} has inconsistent immutable charge components.`);
      }
    }
    published.push({ planKey: plan.planKey, version: plan.version,
      planVersionId });
  }

  await client.query("COMMIT");
  console.log(JSON.stringify({ sellerId, legalVersionId, policyVersionId,
    providerEnvironment: catalog.providerAccount.environment, providerAccountKey: catalog.providerAccount.accountKey,
    plans: published }, null, 2));
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}

import "reflect-metadata";
import { runtimeConfig } from "../config/runtime-config.js";
import { DatabaseService } from "../database/database.service.js";
import { StripeBillingCommercialMilestoneDispatcher } from
  "../admin/billing/stripe-billing-commercial-milestone.dispatcher.js";
import { StripeBillingInvoiceAdjustmentDispatcher } from
  "../admin/billing/stripe-billing-invoice-adjustment.dispatcher.js";
import { STRIPE_BILLING_PROVIDER_KEY } from "../admin/billing/stripe-billing.constants.js";

type SellerPolicy = {
  seller_legal_entity_id: string;
  seller_commercial_policy_version_id: string;
  seller_key: string;
  legal_form: string;
  jurisdiction_country: string;
  registration_identifier_type: string | null;
  customer_scope: string;
  gst_registered: boolean;
  tax_jurisdiction_country: string;
  tax_calculation_mode: string;
  price_display_mode: string;
};

type RecentMfaProof = { proved_at: Date | string };
type CurrentTaxAttestation = { attested_at: Date | string };

const config = runtimeConfig();
if (config.billing.provider !== "stripe_live" || !config.billing.stripeSecretKey?.startsWith("sk_live_")) {
  throw new Error("The live activation audit requires stripe_live and the deployed live Stripe key.");
}
if (config.billing.liveCheckoutEnabled) {
  throw new Error("Live Checkout must remain disabled during the activation audit.");
}

const database = new DatabaseService();
try {
  const sellerPolicies = await database.query<SellerPolicy>(
    `SELECT seller.seller_legal_entity_id,policy.seller_commercial_policy_version_id,
            seller.seller_key,legal.legal_form,legal.jurisdiction_country,
            legal.registration_identifier_type,policy.customer_scope,policy.gst_registered,
            policy.tax_jurisdiction_country,policy.tax_calculation_mode,policy.price_display_mode
     FROM ${config.schema}.seller_billing_provider_accounts account
     JOIN ${config.schema}.seller_legal_entities seller
       ON seller.seller_legal_entity_id=account.seller_legal_entity_id AND seller.status='active'
     JOIN LATERAL (
       SELECT legal_form,jurisdiction_country,registration_identifier_type
       FROM ${config.schema}.seller_legal_entity_versions
       WHERE seller_legal_entity_id=seller.seller_legal_entity_id AND status='published'
         AND effective_from<=now() AND (effective_to IS NULL OR effective_to>now())
       ORDER BY effective_from DESC LIMIT 2
     ) legal ON true
     JOIN LATERAL (
       SELECT seller_commercial_policy_version_id,customer_scope,gst_registered,
              tax_jurisdiction_country,tax_calculation_mode,price_display_mode
       FROM ${config.schema}.seller_commercial_policy_versions
       WHERE seller_legal_entity_id=seller.seller_legal_entity_id AND status='published'
         AND effective_from<=now() AND (effective_to IS NULL OR effective_to>now())
       ORDER BY effective_from DESC LIMIT 2
     ) policy ON true
     WHERE account.provider_key=$2 AND account.provider_environment='live'
       AND account.provider_account_key=$1 AND account.status='active'`,
    [config.billing.providerAccountKey, STRIPE_BILLING_PROVIDER_KEY],
  );
  const policy = sellerPolicies.rows.length === 1 ? sellerPolicies.rows[0] : null;
  const storedTaxPolicyIsCoherent = Boolean(policy
    && policy.legal_form === "sole_trader" && policy.jurisdiction_country === "AU"
    && policy.registration_identifier_type === "ABN" && policy.customer_scope === "business_only"
    && policy.gst_registered === false && policy.tax_jurisdiction_country === "AU"
    && policy.tax_calculation_mode === "none" && policy.price_display_mode === "no_tax");
  const adjustment = new StripeBillingInvoiceAdjustmentDispatcher(config.billing).status();
  const milestone = new StripeBillingCommercialMilestoneDispatcher(config.billing).status();
  const recentMfaProofs = await database.query<RecentMfaProof>(
    `SELECT ${config.schema}.latest_billing_authorization_proof() AS proved_at`,
  );
  const recentMfaProof = recentMfaProofs.rows[0]?.proved_at ? recentMfaProofs.rows[0] : null;
  const currentTaxAttestations = policy ? await database.query<CurrentTaxAttestation>(
    `SELECT ${config.schema}.latest_current_seller_tax_attestation($1,$2) AS attested_at`,
    [policy.seller_legal_entity_id, policy.seller_commercial_policy_version_id],
  ) : { rows: [] };
  const currentTaxAttestation = currentTaxAttestations.rows[0]?.attested_at
    ? currentTaxAttestations.rows[0] : null;

  const gates = [
    { id: "checkout_disabled", status: "pass", detail: "Real charge-creating Checkout remains disabled." },
    { id: "catalog_and_webhook", status: "pass", detail: "Use billing:verify-live again immediately before activation." },
    { id: "stored_tax_policy", status: storedTaxPolicyIsCoherent ? "pass" : "blocked",
      detail: storedTaxPolicyIsCoherent
        ? "The effective stored policy is AU sole trader, ABN, business-only and non-GST."
        : "Exactly one coherent effective seller policy was not found." },
    { id: "current_tax_attestation", status: currentTaxAttestation ? "pass" : "operator_required",
      detail: currentTaxAttestation
        ? "A current owner attestation confirms non-registration and current/projected GST turnover below AU$75,000."
        : "The seller/accountant must reconfirm current and projected GST turnover and registration before the first invoice." },
    { id: "recent_mfa", status: recentMfaProof ? "pass" : "blocked",
      detail: recentMfaProof
        ? "A recent MFA-authenticated billing.manage authorization proof is recorded."
        : "No recent MFA-authenticated billing.manage authorization proof is recorded." },
    { id: "live_overage_collection", status: adjustment.availability === "configured" ? "pass" : "blocked",
      detail: adjustment.detail },
    { id: "live_founding_milestone", status: milestone.availability === "configured" ? "pass" : "blocked",
      detail: milestone.detail },
    { id: "stripe_key_scope", status: "security_review_required",
      detail: "The runtime currently uses a standard sk_live key. Move to a least-privilege restricted key or document why required permissions prevent it, and apply IP restrictions where deployment egress permits." },
    { id: "genuine_customer", status: "waiting",
      detail: "No synthetic live charge is needed. Complete tenant, plan, contract, billing-contact and acceptance checks when the genuine customer is ready." },
  ] as const;
  const blockers = gates.filter((gate) => gate.status !== "pass").map((gate) => gate.id);

  process.stdout.write(`${JSON.stringify({
    stage: "live_activation_audit",
    decision: blockers.length === 0 ? "ready_for_explicit_charge_authority" : "keep_checkout_disabled",
    providerAccountKey: config.billing.providerAccountKey,
    sellerPolicy: policy ? {
      sellerKey: policy.seller_key,
      legalForm: policy.legal_form,
      jurisdiction: policy.jurisdiction_country,
      customerScope: policy.customer_scope,
      gstRegistered: policy.gst_registered,
      taxMode: policy.tax_calculation_mode,
      priceDisplayMode: policy.price_display_mode,
    } : null,
    recentMfaProofAt: recentMfaProof ? new Date(recentMfaProof.proved_at).toISOString() : null,
    currentTaxAttestationAt: currentTaxAttestation
      ? new Date(currentTaxAttestation.attested_at).toISOString() : null,
    gates,
    blockers,
    externalMutation: false,
    stripeRequest: false,
    checkoutEnabled: false,
    chargeCreated: false,
  }, null, 2)}\n`);
} finally {
  await database.onModuleDestroy();
}

import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { z } from "zod";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";
import { AdminAuditService } from "../authorization/admin-audit.service.js";
import type { AdminPrincipal } from "../contracts/admin-contracts.js";
import {
  BILLING_PROVIDER,
  type BillingInvoiceObservation,
  type BillingProvider,
  type BillingSubscriptionObservation,
  type BillingWebhookEvidence,
} from "./billing-provider.port.js";
import { hostedActionSchema, hostedCheckoutSchema, liveCustomerBindingSchema } from "./billing-lifecycle.contracts.js";
import { STRIPE_BILLING_OBSERVATION_EVENT_TYPES, STRIPE_BILLING_PROVIDER_KEY } from "./stripe-billing.constants.js";
import { BillingPeriodLedgerService } from "./billing-period-ledger.service.js";
import { BillingMeterOutboxService } from "./billing-meter-outbox.service.js";
import { BillingInvoiceAdjustmentOutboxService } from "./billing-invoice-adjustment-outbox.service.js";

const supportedWebhookTypes = new Set<string>(STRIPE_BILLING_OBSERVATION_EVENT_TYPES);
const checkoutMeteredRateSchema = z.object({
  dimensions: z.tuple([z.object({
    dimension: z.literal("active-seconds"), includedQuantity: z.literal("120000"),
    unitQuantity: z.literal("60"), unitPriceMinor: z.string().regex(/^\d+$/),
  }).strict()]),
}).strict();

@Injectable()
export class BillingLifecycleService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
    @Inject(AdminAuditService) private readonly audit: AdminAuditService,
    @Inject(BillingPeriodLedgerService) private readonly periodLedgers: BillingPeriodLedgerService,
    @Inject(BillingMeterOutboxService) private readonly meterOutbox: BillingMeterOutboxService,
    @Inject(BillingInvoiceAdjustmentOutboxService)
    private readonly invoiceAdjustments: BillingInvoiceAdjustmentOutboxService,
  ) {}

  status() { return this.provider.status(); }

  async checkout(tenantId: string, principal: AdminPrincipal, body: unknown) {
    const input = hostedCheckoutSchema.parse(body);
    const status = this.provider.status();
    const environment = providerEnvironment(status.availability);
    if (!status.checkout) throw new ServiceUnavailableException(environment === "live"
      ? "Live Checkout is disabled pending explicit real-charge activation."
      : "Hosted Checkout is not available.");
    const accountKey = providerAccountKey(status.providerAccountKey);
    const context = await this.billingContext(tenantId, environment, accountKey);
    if (!context.planVersionId || context.planVersionId !== input.planVersionId) {
      throw new ConflictException("Checkout must use the tenant's current active commercial plan version.");
    }
    if (!this.provider.mappedPlanVersionIds().has(input.planVersionId)) {
      throw new ConflictException(`The active plan has no approved Sophia ${environment} Price mapping.`);
    }
    const meteredOverage = checkoutMeteredOverage(context.rateCard, context.rateCardDimensions);
    if (context.pricingStatus !== "configured" || !context.currency || !context.interval || context.baseChargeMinor === null
      || context.taxMode !== "not_applicable" || (context.rateCardDimensions > 0 && !meteredOverage)) {
      throw new ConflictException("Hosted Checkout requires an approved fixed base and optional exact active-minute overage rate card with tax marked not applicable.");
    }
    const schema = runtimeConfig().schema;
    try {
      await this.database.tenantTransaction(tenantId, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`billing-checkout:${environment}:${accountKey}:${tenantId}`]);
        await client.query(
          `UPDATE ${schema}.billing_checkout_intents SET status='expired',completed_at=now()
          WHERE customer_id=$1 AND provider_key=$2 AND provider_environment=$3 AND provider_account_key=$4
             AND status='created' AND expires_at<=now()`, [tenantId, STRIPE_BILLING_PROVIDER_KEY, environment, accountKey]);
        await client.query(
        `INSERT INTO ${schema}.billing_checkout_intents
          (customer_id,provider_key,provider_environment,provider_account_key,request_id,commercial_plan_version_id,status)
         VALUES ($1,$2,$3,$4,$5,$6,'allocating')
         ON CONFLICT (customer_id,provider_key,provider_environment,provider_account_key,request_id) DO NOTHING`,
        [tenantId, STRIPE_BILLING_PROVIDER_KEY, environment, accountKey, input.requestId, input.planVersionId]);
        const reservation = await client.query<{ commercial_plan_version_id: string; status: string }>(
          `SELECT commercial_plan_version_id,status FROM ${schema}.billing_checkout_intents
         WHERE customer_id=$1 AND provider_key=$2 AND provider_environment=$3 AND provider_account_key=$4 AND request_id=$5`,
          [tenantId, STRIPE_BILLING_PROVIDER_KEY, environment, accountKey, input.requestId]);
        if (reservation.rows[0]?.commercial_plan_version_id !== input.planVersionId
          || !["allocating", "outcome_unknown", "created"].includes(reservation.rows[0]?.status ?? "")) {
          throw new ConflictException("The Checkout request ID is unavailable or already finalized.");
        }
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException(`Another Sophia ${environment} Checkout is already active for this tenant.`);
      throw error;
    }
    let result: Awaited<ReturnType<BillingProvider["createHostedCheckout"]>>;
    try {
      result = await this.provider.createHostedCheckout({ tenantId, planVersionId: input.planVersionId,
        requestId: input.requestId, customerRef: context.customerRef,
        commercial: { currency: context.currency, interval: context.interval, baseChargeMinor: context.baseChargeMinor,
          meteredOverage } });
      if (!result.expiresAt || Date.parse(result.expiresAt) <= Date.now()) {
        throw new ConflictException("Stripe did not return a usable future Checkout expiry.");
      }
      await this.database.tenantTransaction(tenantId, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`billing-checkout:${environment}:${accountKey}:${tenantId}`]);
        await client.query(
          `UPDATE ${schema}.billing_checkout_intents SET status='created',external_checkout_ref=$6,expires_at=$7
           WHERE customer_id=$1 AND provider_key=$2 AND provider_environment=$3 AND provider_account_key=$4
             AND request_id=$5 AND status IN ('allocating','outcome_unknown')`,
          [tenantId, STRIPE_BILLING_PROVIDER_KEY, environment, accountKey, input.requestId, result.externalCheckoutRef, result.expiresAt]);
        const issued = await client.query<{ commercial_plan_version_id: string; external_checkout_ref: string; status: string }>(
          `SELECT commercial_plan_version_id,external_checkout_ref,status FROM ${schema}.billing_checkout_intents
           WHERE customer_id=$1 AND provider_key=$2 AND provider_environment=$3 AND provider_account_key=$4 AND request_id=$5`,
          [tenantId, STRIPE_BILLING_PROVIDER_KEY, environment, accountKey, input.requestId]);
        if (issued.rows[0]?.commercial_plan_version_id !== input.planVersionId || issued.rows[0]?.status !== "created"
          || issued.rows[0]?.external_checkout_ref !== result.externalCheckoutRef) {
          throw new ConflictException("The Checkout request ID is already bound to different provider state.");
        }
      });
    } catch (error) {
      await this.database.tenantTransaction(tenantId, (client) => client.query(
        `UPDATE ${schema}.billing_checkout_intents SET status='outcome_unknown'
         WHERE customer_id=$1 AND provider_key=$2 AND provider_environment=$3 AND provider_account_key=$4
           AND request_id=$5 AND status='allocating'`,
        [tenantId, STRIPE_BILLING_PROVIDER_KEY, environment, accountKey, input.requestId])).catch(() => undefined);
      throw error;
    }
    await this.audit.record({ tenantId, identityUserId: principal.identityUserId, eventType: "billing.checkout.created",
      permission: "billing.manage", outcome: "allowed", resourceType: "commercialPlanVersion",
      resourceId: input.planVersionId, metadata: { providerKey: status.providerKey, providerAccountKey: accountKey,
        environment, requestId: input.requestId } });
    return { url: result.url, expiresAt: result.expiresAt, environment, liveCharge: environment === "live" };
  }

  async portal(tenantId: string, principal: AdminPrincipal, body: unknown) {
    const input = hostedActionSchema.parse(body); const status = this.provider.status();
    const environment = providerEnvironment(status.availability);
    const accountKey = providerAccountKey(status.providerAccountKey);
    if (!status.portal) throw new ServiceUnavailableException("Hosted billing portal is not available.");
    const context = await this.billingContext(tenantId, environment, accountKey);
    if (!context.customerRef) throw new NotFoundException(`No Sophia ${environment} billing customer is linked to this tenant.`);
    const result = await this.provider.createHostedPortal({ tenantId, requestId: input.requestId, customerRef: context.customerRef });
    await this.audit.record({ tenantId, identityUserId: principal.identityUserId, eventType: "billing.portal.created",
      permission: "billing.manage", outcome: "allowed", resourceType: "billingCustomer",
      metadata: { providerKey: status.providerKey, providerAccountKey: accountKey, environment, requestId: input.requestId } });
    return { ...result, environment, liveCharge: false };
  }

  async bindCustomer(tenantId: string, principal: AdminPrincipal, body: unknown) {
    const input = liveCustomerBindingSchema.parse(body);
    const status = this.provider.status();
    if (status.availability !== "live" || status.checkout) {
      throw new ServiceUnavailableException("Customer bootstrap binding is available only in live mode while Checkout is disabled.");
    }
    const accountKey = providerAccountKey(status.providerAccountKey);
    const verified = await this.provider.verifyCustomerBinding({ tenantId, customerRef: input.customerRef });
    const resolved = await this.database.query<{ tenant_id: string | null }>(
      `SELECT ${runtimeConfig().schema}.resolve_billing_customer_tenant($1,'live',$2,$3) AS tenant_id`,
      [STRIPE_BILLING_PROVIDER_KEY, accountKey, input.customerRef]);
    if (resolved.rows[0]?.tenant_id && resolved.rows[0].tenant_id !== tenantId) {
      throw new ConflictException("The verified live Customer is already bound to another Sophia tenant.");
    }
    let alreadyBound = resolved.rows[0]?.tenant_id === tenantId;
    if (!alreadyBound) {
      try {
        await this.database.tenantTransaction(tenantId, async (client) => {
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            [`billing-customer:live:${accountKey}:${tenantId}`]);
          const existing = await client.query<{ external_customer_ref: string }>(
            `SELECT external_customer_ref FROM ${runtimeConfig().schema}.billing_provider_customers
             WHERE customer_id=$1 AND provider_key=$2 AND provider_environment='live' AND provider_account_key=$3 FOR UPDATE`,
            [tenantId, STRIPE_BILLING_PROVIDER_KEY, accountKey]);
          if (existing.rows[0]) {
            if (existing.rows[0].external_customer_ref !== input.customerRef) {
              throw new ConflictException("This tenant is already linked to another live Sophia billing Customer.");
            }
            alreadyBound = true;
            return;
          }
          await client.query(
            `INSERT INTO ${runtimeConfig().schema}.billing_provider_customers
              (customer_id,provider_key,provider_environment,provider_account_key,external_customer_ref,observed_at)
             VALUES ($1,$2,'live',$3,$4,$5)`,
            [tenantId, STRIPE_BILLING_PROVIDER_KEY, accountKey, input.customerRef, verified.observedAt]);
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictException("The verified live Customer binding conflicts with existing provider state.");
        throw error;
      }
    }
    await this.audit.record({ tenantId, identityUserId: principal.identityUserId,
      eventType: "billing.customer.bound", permission: "billing.manage", outcome: "allowed",
      resourceType: "billingCustomer", metadata: { providerKey: STRIPE_BILLING_PROVIDER_KEY,
        providerAccountKey: accountKey, environment: "live", requestId: input.requestId, alreadyBound } });
    return { environment: "live", providerCustomerBound: true, alreadyBound,
      observedAt: verified.observedAt, liveCharge: false };
  }

  async reconcile(tenantId: string, principal: AdminPrincipal, body: unknown) {
    const input = hostedActionSchema.parse(body); const status = this.provider.status();
    const environment = providerEnvironment(status.availability);
    const accountKey = providerAccountKey(status.providerAccountKey);
    if (!status.reconciliation) throw new ServiceUnavailableException("Billing reconciliation is not available.");
    const context = await this.billingContext(tenantId, environment, accountKey);
    if (!context.customerRef) throw new NotFoundException(`No Sophia ${environment} billing customer is linked to this tenant.`);
    const result = await this.provider.reconcileTenant({ tenantId, customerRef: context.customerRef });
    await this.database.tenantTransaction(tenantId, async (client) => {
      for (const subscription of result.subscriptions) await upsertSubscription(client, tenantId, STRIPE_BILLING_PROVIDER_KEY,
        environment, accountKey, subscription);
      for (const invoice of result.invoices) await upsertInvoice(client, tenantId, STRIPE_BILLING_PROVIDER_KEY,
        environment, accountKey, invoice);
    });
    const periodLedger = await this.periodLedgers.finaliseEligible(
      tenantId, status.providerKey ?? STRIPE_BILLING_PROVIDER_KEY, environment, accountKey,
    );
    const meterEventDispatch = environment === "sandbox"
      ? await this.meterOutbox.dispatchNext(tenantId, status.providerKey ?? STRIPE_BILLING_PROVIDER_KEY,
        environment, accountKey, `billing-reconcile:${input.requestId}`)
      : { status: "disabled" as const,
        detail: "Live Meter dispatch is disabled pending explicit live usage-billing activation." };
    const meterEventReconciliation = await this.meterOutbox.reconcileNext(
      tenantId, status.providerKey ?? STRIPE_BILLING_PROVIDER_KEY, environment, accountKey,
    );
    await this.audit.record({ tenantId, identityUserId: principal.identityUserId, eventType: "billing.reconciled",
      permission: "billing.manage", outcome: "allowed",
      resourceType: "billingCustomer", metadata: { providerKey: status.providerKey,
        providerAccountKey: accountKey, environment, reconciliationStatus: result.status,
        requestId: input.requestId, subscriptionCount: result.subscriptions.length, invoiceCount: result.invoices.length } });
    return { status: result.status, observedAt: result.observedAt,
      subscriptionCount: result.subscriptions.length, invoiceCount: result.invoices.length,
      periodLedger, meterEventDispatch, meterEventReconciliation, liveEntitlementMutation: false };
  }

  async webhook(headers: Readonly<Record<string, string | undefined>>, rawBody: Uint8Array) {
    if (!rawBody.length) throw new BadRequestException("A raw signed webhook body is required.");
    const event = await this.provider.verifyWebhook(headers, rawBody);
    const tenantId = await this.resolveWebhookTenant(event);
    if (!tenantId) throw new NotFoundException("The Stripe customer is not linked to a Sophia tenant.");
    const response = await this.database.tenantTransaction(tenantId, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`billing:${event.providerKey}:${event.environment}:${event.providerAccountKey}:${event.eventId}`]);
      const inserted = await client.query(
        `INSERT INTO ${runtimeConfig().schema}.billing_webhook_events
          (customer_id,provider_key,provider_environment,provider_account_key,external_event_ref,event_type,payload_digest,occurred_at,processing_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'received') ON CONFLICT DO NOTHING RETURNING billing_webhook_event_id`,
        [tenantId, event.providerKey, event.environment, event.providerAccountKey,
          event.eventId, event.eventType, event.payloadDigest, event.occurredAt]);
      if (inserted.rowCount === 0) return { received: true, duplicate: true };
      if (event.eventType === "checkout.session.completed") await this.bindCheckoutCustomer(client, tenantId, event);
      const supported = supportedWebhookTypes.has(event.eventType);
      if (supported && event.subscription) await upsertSubscription(client, tenantId, event.providerKey,
        event.environment, event.providerAccountKey, event.subscription);
      if (supported && event.invoice) await upsertInvoice(client, tenantId, event.providerKey,
        event.environment, event.providerAccountKey, event.invoice);
      await client.query(
        `UPDATE ${runtimeConfig().schema}.billing_webhook_events
         SET processing_status=$4,processing_detail=$5,processed_at=now()
         WHERE provider_key=$1 AND provider_environment=$2 AND provider_account_key=$3 AND external_event_ref=$6`,
        [event.providerKey, event.environment, event.providerAccountKey, supported ? "processed" : "ignored",
          supported ? "provider_observation_applied" : "unsupported_event_type", event.eventId]);
      return { received: true, duplicate: false };
    });
    const reconciliationResult = event.invoice
      && (event.eventType === "invoice.finalized" || event.eventType === "invoice.paid")
      ? await this.invoiceAdjustments.reconcileInvoice(tenantId, event.providerKey, event.environment,
        event.providerAccountKey, event.invoice.externalRef)
      : null;
    const invoiceAdjustmentReconciliation = reconciliationResult?.status === "idle" ? null : reconciliationResult;
    if (!event.draftRenewalInvoice || !event.customerRef) {
      return invoiceAdjustmentReconciliation ? { ...response, invoiceAdjustmentReconciliation } : response;
    }
    const periodLedger = event.environment === "sandbox"
      ? await this.periodLedgers.finaliseSandboxTestClock(
        tenantId, event.providerKey, event.providerAccountKey, event.occurredAt)
      : await this.periodLedgers.finaliseEligible(
        tenantId, event.providerKey, event.environment, event.providerAccountKey);
    const enqueued = await this.invoiceAdjustments.enqueueDraftInvoice(tenantId, {
      providerKey: event.providerKey,
      providerEnvironment: event.environment,
      providerAccountKey: event.providerAccountKey,
      externalCustomerRef: event.customerRef,
      externalSubscriptionRef: event.draftRenewalInvoice.externalSubscriptionRef,
      externalInvoiceRef: event.draftRenewalInvoice.externalInvoiceRef,
      periodStart: event.draftRenewalInvoice.periodStart,
      periodEnd: event.draftRenewalInvoice.periodEnd,
    });
    if (event.environment === "sandbox" && enqueued.status === "not_eligible") {
      throw new ServiceUnavailableException(
        "The exact immutable overage ledger is not ready for this draft renewal invoice; Stripe must retry the signed event.",
      );
    }
    if (enqueued.status === "not_required") {
      return { ...response, periodLedger, invoiceAdjustmentEnqueue: enqueued,
        invoiceAdjustment: { status: "not_required" as const }, invoiceAdjustmentReconciliation };
    }
    let adjustment = event.environment === "sandbox"
      ? await this.invoiceAdjustments.dispatchNext(tenantId, event.providerKey, event.environment,
        event.providerAccountKey, `invoice-created:${event.eventId}`)
      : { status: "disabled" as const, detail: "Live overage invoice adjustment is not authorized." };
    if (event.environment === "sandbox" && adjustment.status === "idle"
      && "adjustmentId" in enqueued && typeof enqueued.adjustmentId === "string") {
      adjustment = await this.invoiceAdjustments.authoritativeAcceptance(tenantId, enqueued.adjustmentId)
        ?? adjustment;
    }
    if (event.environment === "sandbox" && adjustment.status !== "provider_accepted") {
      throw new ServiceUnavailableException(
        "The sandbox overage adjustment is not authoritatively attached to the draft invoice; Stripe must retry the signed event.",
      );
    }
    return { ...response, periodLedger, invoiceAdjustmentEnqueue: enqueued, invoiceAdjustment: adjustment,
      invoiceAdjustmentReconciliation };
  }

  private async billingContext(tenantId: string, environment: "sandbox" | "live", accountKey: string) {
    const schema = runtimeConfig().schema;
    return this.database.tenantReadTransaction(tenantId, async (client) => {
      const result = await client.query<{ commercial_plan_version_id: string | null; external_customer_ref: string | null;
        pricing_status: string | null; billing_currency: string | null; billing_interval: "month" | "year" | null;
        base_charge_minor: string | null; tax_mode: string | null; rate_card: unknown; rate_card_dimensions: string }>(
        `SELECT plan.commercial_plan_version_id,plan.pricing_status,plan.billing_currency,plan.billing_interval,
                plan.base_charge_minor::text,plan.tax_mode,plan.rate_card,plan.rate_card_dimensions::text,customer.external_customer_ref
         FROM ${schema}.customers c
         LEFT JOIN LATERAL (
           SELECT p.commercial_plan_version_id,p.pricing_status,p.billing_currency,p.billing_interval,p.base_charge_minor,
                  p.tax_mode,p.rate_card,jsonb_array_length(COALESCE(p.rate_card->'dimensions','[]'::jsonb)) AS rate_card_dimensions
           FROM ${schema}.tenant_commercial_assignments a JOIN ${schema}.commercial_plan_versions p
             ON p.commercial_plan_version_id=a.commercial_plan_version_id
           WHERE a.customer_id=c.customer_id AND a.status='active' AND a.effective_from<=now()
             AND (a.effective_to IS NULL OR a.effective_to>now()) AND p.status IN ('published','retired')
           ORDER BY a.effective_from DESC LIMIT 1
         ) plan ON true
         LEFT JOIN ${schema}.billing_provider_customers customer
           ON customer.customer_id=c.customer_id AND customer.provider_key=$3 AND customer.provider_environment=$2
             AND customer.provider_account_key=$4
         WHERE c.customer_id=$1`, [tenantId, environment, STRIPE_BILLING_PROVIDER_KEY, accountKey]);
      if (!result.rows[0]) throw new NotFoundException("Tenant not found.");
      const row = result.rows[0];
      return { planVersionId: row.commercial_plan_version_id, customerRef: row.external_customer_ref,
        pricingStatus: row.pricing_status, currency: row.billing_currency, interval: row.billing_interval,
        baseChargeMinor: row.base_charge_minor, taxMode: row.tax_mode, rateCard: row.rate_card,
        rateCardDimensions: Number(row.rate_card_dimensions ?? 0) };
    });
  }

  private async resolveWebhookTenant(event: BillingWebhookEvidence): Promise<string | null> {
    if (event.eventType === "checkout.session.completed" && event.tenantHint) return event.tenantHint;
    if (!event.customerRef) return null;
    const result = await this.database.query<{ tenant_id: string | null }>(
      `SELECT ${runtimeConfig().schema}.resolve_billing_customer_tenant($1,$2,$3,$4) AS tenant_id`,
      [event.providerKey, event.environment, event.providerAccountKey, event.customerRef]);
    return result.rows[0]?.tenant_id ?? null;
  }

  private async bindCheckoutCustomer(client: PoolClient, tenantId: string, event: BillingWebhookEvidence) {
    if (!event.customerRef || !event.checkoutRef || !event.planVersionHint || !this.provider.mappedPlanVersionIds().has(event.planVersionHint)) {
      throw new ConflictException(`Checkout metadata does not identify an approved Sophia ${event.environment} customer and plan.`);
    }
    const schema = runtimeConfig().schema;
    const assignment = await client.query(
      `SELECT 1 FROM ${schema}.tenant_commercial_assignments
       WHERE customer_id=$1 AND commercial_plan_version_id=$2 AND status='active' AND effective_from<=now()
         AND (effective_to IS NULL OR effective_to>now()) LIMIT 1`, [tenantId, event.planVersionHint]);
    if (!assignment.rows[0]) throw new ConflictException("Checkout plan no longer matches the tenant's active assignment.");
    const issued = await client.query<{ expires_at: Date | string }>(
      `SELECT expires_at FROM ${schema}.billing_checkout_intents
       WHERE customer_id=$1 AND provider_key=$2 AND provider_environment=$3
         AND provider_account_key=$4 AND commercial_plan_version_id=$5 AND external_checkout_ref=$6 AND status='created' FOR UPDATE`,
      [tenantId, event.providerKey, event.environment, event.providerAccountKey, event.planVersionHint, event.checkoutRef]);
    if (!issued.rows[0] || new Date(event.occurredAt) > new Date(issued.rows[0].expires_at)) {
      throw new ConflictException(`Checkout completion does not match an unexpired Sophia-issued ${event.environment} intent.`);
    }
    const existing = await client.query<{ external_customer_ref: string }>(
       `SELECT external_customer_ref FROM ${schema}.billing_provider_customers
       WHERE customer_id=$1 AND provider_key=$2 AND provider_environment=$3 AND provider_account_key=$4`,
      [tenantId, event.providerKey, event.environment, event.providerAccountKey]);
    if (existing.rows[0] && existing.rows[0].external_customer_ref !== event.customerRef) {
      throw new ConflictException(`This tenant is already linked to another Sophia ${event.environment} billing customer.`);
    }
    await client.query(
      `INSERT INTO ${schema}.billing_provider_customers
        (customer_id,provider_key,provider_environment,provider_account_key,external_customer_ref,observed_at)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (customer_id,provider_key,provider_environment,provider_account_key)
       DO UPDATE SET observed_at=GREATEST(billing_provider_customers.observed_at,EXCLUDED.observed_at),
         revision=billing_provider_customers.revision+1`,
      [tenantId, event.providerKey, event.environment, event.providerAccountKey, event.customerRef, event.occurredAt]);
    await client.query(
      `UPDATE ${schema}.billing_checkout_intents SET status='completed',completed_at=now()
       WHERE customer_id=$1 AND provider_key=$2 AND provider_environment=$3 AND provider_account_key=$4 AND external_checkout_ref=$5`,
      [tenantId, event.providerKey, event.environment, event.providerAccountKey, event.checkoutRef]);
  }
}

function checkoutMeteredOverage(rateCard: unknown, dimensions: number) {
  if (dimensions === 0) return null;
  const parsed = checkoutMeteredRateSchema.safeParse(rateCard);
  return parsed.success
    ? { unitPriceMinor: parsed.data.dimensions[0].unitPriceMinor, meterBindingKey: "active-overage-minutes" }
    : null;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "23505");
}

async function upsertSubscription(client: PoolClient, tenantId: string, providerKey: string,
  environment: "sandbox" | "live", accountKey: string, value: BillingSubscriptionObservation) {
  const schema = runtimeConfig().schema;
  await client.query(
    `INSERT INTO ${schema}.billing_subscription_references
      (customer_id,provider_key,provider_environment,provider_account_key,external_subscription_ref,status,current_period_start,current_period_end,observed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (provider_key,provider_environment,provider_account_key,external_subscription_ref) DO UPDATE SET
       customer_id=EXCLUDED.customer_id,status=EXCLUDED.status,
       current_period_start=EXCLUDED.current_period_start,current_period_end=EXCLUDED.current_period_end,
       observed_at=EXCLUDED.observed_at,revision=billing_subscription_references.revision+1
     WHERE EXCLUDED.observed_at>=billing_subscription_references.observed_at`,
    [tenantId, providerKey, environment, accountKey, value.externalRef, value.status,
      value.currentPeriodStart, value.currentPeriodEnd, value.observedAt]);
}
async function upsertInvoice(client: PoolClient, tenantId: string, providerKey: string,
  environment: "sandbox" | "live", accountKey: string, value: BillingInvoiceObservation) {
  const schema = runtimeConfig().schema;
  await client.query(
    `INSERT INTO ${schema}.billing_invoice_references
      (customer_id,provider_key,provider_environment,provider_account_key,external_invoice_ref,status,currency,amount_due_minor,amount_paid_minor,hosted_invoice_url,due_at,observed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (provider_key,provider_environment,provider_account_key,external_invoice_ref) DO UPDATE SET
       customer_id=EXCLUDED.customer_id,status=EXCLUDED.status,currency=EXCLUDED.currency,amount_due_minor=EXCLUDED.amount_due_minor,
       amount_paid_minor=EXCLUDED.amount_paid_minor,hosted_invoice_url=EXCLUDED.hosted_invoice_url,due_at=EXCLUDED.due_at,
       observed_at=EXCLUDED.observed_at,revision=billing_invoice_references.revision+1
     WHERE EXCLUDED.observed_at>=billing_invoice_references.observed_at`,
    [tenantId, providerKey, environment, accountKey, value.externalRef, value.status, value.currency,
      value.amountDueMinor, value.amountPaidMinor, value.hostedInvoiceUrl, value.dueAt, value.observedAt]);
}

function providerEnvironment(availability: "disabled" | "sandbox" | "live"): "sandbox" | "live" {
  if (availability === "disabled") throw new ServiceUnavailableException("Sophia billing provider is not fully configured.");
  return availability;
}

function providerAccountKey(value: string | null): string {
  if (!value) throw new ServiceUnavailableException("Sophia billing provider account scope is not configured.");
  return value;
}

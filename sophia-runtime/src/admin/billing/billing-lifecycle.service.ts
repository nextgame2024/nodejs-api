import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type { PoolClient } from "pg";
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
import { hostedActionSchema, hostedCheckoutSchema } from "./billing-lifecycle.contracts.js";

const supportedWebhookTypes = new Set([
  "checkout.session.completed",
  "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted",
  "customer.subscription.paused", "customer.subscription.resumed",
  "invoice.created", "invoice.finalized", "invoice.paid", "invoice.payment_failed",
  "invoice.voided", "invoice.marked_uncollectible",
]);

@Injectable()
export class BillingLifecycleService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
    @Inject(AdminAuditService) private readonly audit: AdminAuditService,
  ) {}

  status() { return this.provider.status(); }

  async checkout(tenantId: string, principal: AdminPrincipal, body: unknown) {
    const input = hostedCheckoutSchema.parse(body);
    const status = this.provider.status();
    const environment = providerEnvironment(status.availability);
    if (!status.checkout) throw new ServiceUnavailableException(environment === "live"
      ? "Live Checkout is disabled pending explicit real-charge activation."
      : "Hosted Checkout is not available.");
    const context = await this.billingContext(tenantId, environment);
    if (!context.planVersionId || context.planVersionId !== input.planVersionId) {
      throw new ConflictException("Checkout must use the tenant's current active commercial plan version.");
    }
    if (!this.provider.mappedPlanVersionIds().has(input.planVersionId)) {
      throw new ConflictException(`The active plan has no approved Sophia ${environment} Price mapping.`);
    }
    if (context.pricingStatus !== "configured" || !context.currency || !context.interval || context.baseChargeMinor === null
      || context.taxMode !== "not_applicable" || context.rateCardDimensions !== 0) {
      throw new ConflictException("Hosted Checkout requires a configured fixed recurring plan with no usage overage lines and tax marked not applicable.");
    }
    const schema = runtimeConfig().schema;
    try {
      await this.database.tenantTransaction(tenantId, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`billing-checkout:${environment}:${tenantId}`]);
        await client.query(
          `UPDATE ${schema}.billing_checkout_intents SET status='expired',completed_at=now()
          WHERE customer_id=$1 AND provider_key='stripe-sophia' AND provider_environment=$2
             AND status='created' AND expires_at<=now()`, [tenantId, environment]);
        await client.query(
        `INSERT INTO ${schema}.billing_checkout_intents
          (customer_id,provider_key,provider_environment,request_id,commercial_plan_version_id,status)
         VALUES ($1,'stripe-sophia',$2,$3,$4,'allocating')
         ON CONFLICT (customer_id,provider_key,provider_environment,request_id) DO NOTHING`,
        [tenantId, environment, input.requestId, input.planVersionId]);
        const reservation = await client.query<{ commercial_plan_version_id: string; status: string }>(
          `SELECT commercial_plan_version_id,status FROM ${schema}.billing_checkout_intents
         WHERE customer_id=$1 AND provider_key='stripe-sophia' AND provider_environment=$2 AND request_id=$3`,
          [tenantId, environment, input.requestId]);
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
        commercial: { currency: context.currency, interval: context.interval, baseChargeMinor: context.baseChargeMinor } });
      if (!result.expiresAt || Date.parse(result.expiresAt) <= Date.now()) {
        throw new ConflictException("Stripe did not return a usable future Checkout expiry.");
      }
      await this.database.tenantTransaction(tenantId, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`billing-checkout:${environment}:${tenantId}`]);
        await client.query(
          `UPDATE ${schema}.billing_checkout_intents SET status='created',external_checkout_ref=$4,expires_at=$5
           WHERE customer_id=$1 AND provider_key='stripe-sophia' AND provider_environment=$2
             AND request_id=$3 AND status IN ('allocating','outcome_unknown')`,
          [tenantId, environment, input.requestId, result.externalCheckoutRef, result.expiresAt]);
        const issued = await client.query<{ commercial_plan_version_id: string; external_checkout_ref: string; status: string }>(
          `SELECT commercial_plan_version_id,external_checkout_ref,status FROM ${schema}.billing_checkout_intents
           WHERE customer_id=$1 AND provider_key='stripe-sophia' AND provider_environment=$2 AND request_id=$3`,
          [tenantId, environment, input.requestId]);
        if (issued.rows[0]?.commercial_plan_version_id !== input.planVersionId || issued.rows[0]?.status !== "created"
          || issued.rows[0]?.external_checkout_ref !== result.externalCheckoutRef) {
          throw new ConflictException("The Checkout request ID is already bound to different provider state.");
        }
      });
    } catch (error) {
      await this.database.tenantTransaction(tenantId, (client) => client.query(
        `UPDATE ${schema}.billing_checkout_intents SET status='outcome_unknown'
         WHERE customer_id=$1 AND provider_key='stripe-sophia' AND provider_environment=$2
           AND request_id=$3 AND status='allocating'`, [tenantId, environment, input.requestId])).catch(() => undefined);
      throw error;
    }
    await this.audit.record({ tenantId, identityUserId: principal.identityUserId, eventType: "billing.checkout.created",
      permission: "billing.manage", outcome: "allowed", resourceType: "commercialPlanVersion",
      resourceId: input.planVersionId, metadata: { providerKey: status.providerKey, environment, requestId: input.requestId } });
    return { url: result.url, expiresAt: result.expiresAt, environment, liveCharge: environment === "live" };
  }

  async portal(tenantId: string, principal: AdminPrincipal, body: unknown) {
    const input = hostedActionSchema.parse(body); const status = this.provider.status();
    const environment = providerEnvironment(status.availability);
    if (!status.portal) throw new ServiceUnavailableException("Hosted billing portal is not available.");
    const context = await this.billingContext(tenantId, environment);
    if (!context.customerRef) throw new NotFoundException(`No Sophia ${environment} billing customer is linked to this tenant.`);
    const result = await this.provider.createHostedPortal({ tenantId, requestId: input.requestId, customerRef: context.customerRef });
    await this.audit.record({ tenantId, identityUserId: principal.identityUserId, eventType: "billing.portal.created",
      permission: "billing.manage", outcome: "allowed", resourceType: "billingCustomer",
      metadata: { providerKey: status.providerKey, environment, requestId: input.requestId } });
    return { ...result, environment, liveCharge: false };
  }

  async reconcile(tenantId: string, principal: AdminPrincipal, body: unknown) {
    const input = hostedActionSchema.parse(body); const status = this.provider.status();
    const environment = providerEnvironment(status.availability);
    if (!status.reconciliation) throw new ServiceUnavailableException("Billing reconciliation is not available.");
    const context = await this.billingContext(tenantId, environment);
    if (!context.customerRef) throw new NotFoundException(`No Sophia ${environment} billing customer is linked to this tenant.`);
    const result = await this.provider.reconcileTenant({ tenantId, customerRef: context.customerRef });
    await this.database.tenantTransaction(tenantId, async (client) => {
      for (const subscription of result.subscriptions) await upsertSubscription(client, tenantId, "stripe-sophia", environment, subscription);
      for (const invoice of result.invoices) await upsertInvoice(client, tenantId, "stripe-sophia", environment, invoice);
    });
    await this.audit.record({ tenantId, identityUserId: principal.identityUserId, eventType: "billing.reconciled",
      permission: "billing.manage", outcome: "allowed",
      resourceType: "billingCustomer", metadata: { providerKey: status.providerKey,
        environment, reconciliationStatus: result.status,
        requestId: input.requestId, subscriptionCount: result.subscriptions.length, invoiceCount: result.invoices.length } });
    return { status: result.status, observedAt: result.observedAt,
      subscriptionCount: result.subscriptions.length, invoiceCount: result.invoices.length, liveEntitlementMutation: false };
  }

  async webhook(headers: Readonly<Record<string, string | undefined>>, rawBody: Uint8Array) {
    if (!rawBody.length) throw new BadRequestException("A raw signed webhook body is required.");
    const event = await this.provider.verifyWebhook(headers, rawBody);
    const tenantId = await this.resolveWebhookTenant(event);
    if (!tenantId) throw new NotFoundException("The Stripe customer is not linked to a Sophia tenant.");
    return this.database.tenantTransaction(tenantId, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`billing:${event.providerKey}:${event.environment}:${event.eventId}`]);
      const inserted = await client.query(
        `INSERT INTO ${runtimeConfig().schema}.billing_webhook_events
          (customer_id,provider_key,provider_environment,external_event_ref,event_type,payload_digest,occurred_at,processing_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'received') ON CONFLICT DO NOTHING RETURNING billing_webhook_event_id`,
        [tenantId, event.providerKey, event.environment, event.eventId, event.eventType, event.payloadDigest, event.occurredAt]);
      if (inserted.rowCount === 0) return { received: true, duplicate: true };
      if (event.eventType === "checkout.session.completed") await this.bindCheckoutCustomer(client, tenantId, event);
      const supported = supportedWebhookTypes.has(event.eventType);
      if (supported && event.subscription) await upsertSubscription(client, tenantId, event.providerKey, event.environment, event.subscription);
      if (supported && event.invoice) await upsertInvoice(client, tenantId, event.providerKey, event.environment, event.invoice);
      await client.query(
        `UPDATE ${runtimeConfig().schema}.billing_webhook_events
         SET processing_status=$3,processing_detail=$4,processed_at=now()
         WHERE provider_key=$1 AND provider_environment=$2 AND external_event_ref=$5`,
        [event.providerKey, event.environment, supported ? "processed" : "ignored",
          supported ? "provider_observation_applied" : "unsupported_event_type", event.eventId]);
      return { received: true, duplicate: false };
    });
  }

  private async billingContext(tenantId: string, environment: "sandbox" | "live") {
    const schema = runtimeConfig().schema;
    return this.database.tenantReadTransaction(tenantId, async (client) => {
      const result = await client.query<{ commercial_plan_version_id: string | null; external_customer_ref: string | null;
        pricing_status: string | null; billing_currency: string | null; billing_interval: "month" | "year" | null;
        base_charge_minor: string | null; tax_mode: string | null; rate_card_dimensions: string }>(
        `SELECT plan.commercial_plan_version_id,plan.pricing_status,plan.billing_currency,plan.billing_interval,
                plan.base_charge_minor::text,plan.tax_mode,plan.rate_card_dimensions::text,customer.external_customer_ref
         FROM ${schema}.customers c
         LEFT JOIN LATERAL (
           SELECT p.commercial_plan_version_id,p.pricing_status,p.billing_currency,p.billing_interval,p.base_charge_minor,
                  p.tax_mode,jsonb_array_length(COALESCE(p.rate_card->'dimensions','[]'::jsonb)) AS rate_card_dimensions
           FROM ${schema}.tenant_commercial_assignments a JOIN ${schema}.commercial_plan_versions p
             ON p.commercial_plan_version_id=a.commercial_plan_version_id
           WHERE a.customer_id=c.customer_id AND a.status='active' AND a.effective_from<=now()
             AND (a.effective_to IS NULL OR a.effective_to>now()) AND p.status IN ('published','retired')
           ORDER BY a.effective_from DESC LIMIT 1
         ) plan ON true
         LEFT JOIN ${schema}.billing_provider_customers customer
           ON customer.customer_id=c.customer_id AND customer.provider_key='stripe-sophia' AND customer.provider_environment=$2
         WHERE c.customer_id=$1`, [tenantId, environment]);
      if (!result.rows[0]) throw new NotFoundException("Tenant not found.");
      const row = result.rows[0];
      return { planVersionId: row.commercial_plan_version_id, customerRef: row.external_customer_ref,
        pricingStatus: row.pricing_status, currency: row.billing_currency, interval: row.billing_interval,
        baseChargeMinor: row.base_charge_minor, taxMode: row.tax_mode, rateCardDimensions: Number(row.rate_card_dimensions ?? 0) };
    });
  }

  private async resolveWebhookTenant(event: BillingWebhookEvidence): Promise<string | null> {
    if (event.eventType === "checkout.session.completed" && event.tenantHint) return event.tenantHint;
    if (!event.customerRef) return null;
    const result = await this.database.query<{ tenant_id: string | null }>(
      `SELECT ${runtimeConfig().schema}.resolve_billing_customer_tenant($1,$2,$3) AS tenant_id`,
      [event.providerKey, event.environment, event.customerRef]);
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
         AND commercial_plan_version_id=$4 AND external_checkout_ref=$5 AND status='created' FOR UPDATE`,
      [tenantId, event.providerKey, event.environment, event.planVersionHint, event.checkoutRef]);
    if (!issued.rows[0] || new Date(event.occurredAt) > new Date(issued.rows[0].expires_at)) {
      throw new ConflictException(`Checkout completion does not match an unexpired Sophia-issued ${event.environment} intent.`);
    }
    const existing = await client.query<{ external_customer_ref: string }>(
      `SELECT external_customer_ref FROM ${schema}.billing_provider_customers
       WHERE customer_id=$1 AND provider_key=$2 AND provider_environment=$3`,
      [tenantId, event.providerKey, event.environment]);
    if (existing.rows[0] && existing.rows[0].external_customer_ref !== event.customerRef) {
      throw new ConflictException(`This tenant is already linked to another Sophia ${event.environment} billing customer.`);
    }
    await client.query(
      `INSERT INTO ${schema}.billing_provider_customers
        (customer_id,provider_key,provider_environment,external_customer_ref,observed_at)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (customer_id,provider_key,provider_environment)
       DO UPDATE SET observed_at=GREATEST(billing_provider_customers.observed_at,EXCLUDED.observed_at),
         revision=billing_provider_customers.revision+1`,
      [tenantId, event.providerKey, event.environment, event.customerRef, event.occurredAt]);
    await client.query(
      `UPDATE ${schema}.billing_checkout_intents SET status='completed',completed_at=now()
       WHERE customer_id=$1 AND provider_key=$2 AND provider_environment=$3 AND external_checkout_ref=$4`,
      [tenantId, event.providerKey, event.environment, event.checkoutRef]);
  }
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "23505");
}

async function upsertSubscription(client: PoolClient, tenantId: string, providerKey: string,
  environment: "sandbox" | "live", value: BillingSubscriptionObservation) {
  const schema = runtimeConfig().schema;
  await client.query(
    `INSERT INTO ${schema}.billing_subscription_references
      (customer_id,provider_key,provider_environment,external_subscription_ref,status,current_period_start,current_period_end,observed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (provider_key,provider_environment,external_subscription_ref) DO UPDATE SET
       customer_id=EXCLUDED.customer_id,status=EXCLUDED.status,
       current_period_start=EXCLUDED.current_period_start,current_period_end=EXCLUDED.current_period_end,
       observed_at=EXCLUDED.observed_at,revision=billing_subscription_references.revision+1
     WHERE EXCLUDED.observed_at>=billing_subscription_references.observed_at`,
    [tenantId, providerKey, environment, value.externalRef, value.status, value.currentPeriodStart, value.currentPeriodEnd, value.observedAt]);
}
async function upsertInvoice(client: PoolClient, tenantId: string, providerKey: string,
  environment: "sandbox" | "live", value: BillingInvoiceObservation) {
  const schema = runtimeConfig().schema;
  await client.query(
    `INSERT INTO ${schema}.billing_invoice_references
      (customer_id,provider_key,provider_environment,external_invoice_ref,status,currency,amount_due_minor,amount_paid_minor,hosted_invoice_url,due_at,observed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (provider_key,provider_environment,external_invoice_ref) DO UPDATE SET
       customer_id=EXCLUDED.customer_id,status=EXCLUDED.status,currency=EXCLUDED.currency,amount_due_minor=EXCLUDED.amount_due_minor,
       amount_paid_minor=EXCLUDED.amount_paid_minor,hosted_invoice_url=EXCLUDED.hosted_invoice_url,due_at=EXCLUDED.due_at,
       observed_at=EXCLUDED.observed_at,revision=billing_invoice_references.revision+1
     WHERE EXCLUDED.observed_at>=billing_invoice_references.observed_at`,
    [tenantId, providerKey, environment, value.externalRef, value.status, value.currency, value.amountDueMinor,
      value.amountPaidMinor, value.hostedInvoiceUrl, value.dueAt, value.observedAt]);
}

function providerEnvironment(availability: "disabled" | "sandbox" | "live"): "sandbox" | "live" {
  if (availability === "disabled") throw new ServiceUnavailableException("Sophia billing provider is not fully configured.");
  return availability;
}

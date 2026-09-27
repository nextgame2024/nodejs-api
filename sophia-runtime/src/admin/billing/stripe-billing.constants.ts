export const STRIPE_BILLING_PROVIDER_KEY = "stripe-sophia";
export const STRIPE_BILLING_API_VERSION = "2025-08-27.basil";

export const STRIPE_BILLING_OBSERVATION_EVENT_TYPES = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "invoice.created",
  "invoice.finalized",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.voided",
  "invoice.marked_uncollectible",
] as const;

// customer.updated provides a harmless signed-delivery proof after a verified
// live Customer is bound. It is intentionally accepted as evidence only and
// never mutates subscriptions, invoices, entitlements, or plan assignments.
export const STRIPE_BILLING_WEBHOOK_EVENT_TYPES = [
  ...STRIPE_BILLING_OBSERVATION_EVENT_TYPES,
  "customer.updated",
] as const;

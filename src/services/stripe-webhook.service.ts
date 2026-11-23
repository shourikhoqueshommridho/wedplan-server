import type Stripe from "stripe"

import {
  mapStripeSubscriptionStatus,
  subscriptionPeriodEnd,
  toMajorAmount,
} from "./subscriptions.service.js"
import type { SubscriptionPlan, SubscriptionSnapshotInput, SubscriptionStatus } from "../types/subscription.js"

/**
 * All external reads/writes used by webhook processing are injected so the
 * state machine can be tested without a database or a live Stripe account.
 */
export interface WebhookContext {
  vendorIdForSession(sessionId: string): Promise<string | null>
  vendorIdForSubscription(stripeSubscriptionId: string, metadataVendorId?: string | null): Promise<string | null>
  vendorIdForCustomer(customerId: string): Promise<string | null>
  retrieveSubscription(stripeSubscriptionId: string): Promise<Stripe.Subscription>
  commit(input: SubscriptionSnapshotInput): Promise<{ duplicate: boolean }>
}

export interface WebhookResult {
  processed: boolean
  duplicate?: boolean
  ignored?: boolean
  reason?: string
}

function referenceId(value: unknown): string | null {
  if (typeof value === "string") return value || null
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id?: unknown }).id
    return typeof id === "string" ? id : null
  }
  return null
}

/** Stripe v23 exposes the subscription under invoice.parent.subscription_details. */
function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const raw = invoice as unknown as {
    subscription?: unknown
    parent?: { subscription_details?: { subscription?: unknown } } | null
  }
  return referenceId(raw.subscription) ?? referenceId(raw.parent?.subscription_details?.subscription)
}

function metadataVendorId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null
  const metadata = (value as { metadata?: Record<string, unknown> }).metadata
  const vendorId = metadata?.vendorId
  return typeof vendorId === "string" && vendorId.trim() ? vendorId : null
}

function entitled(status: string): boolean {
  return status === "active" || status === "trialing"
}

function planFor(status: string): SubscriptionPlan {
  return entitled(status) ? "premium" : "free"
}

async function commitPending(
  context: WebhookContext,
  event: Stripe.Event,
  vendorId: string,
  input: Partial<SubscriptionSnapshotInput>,
): Promise<WebhookResult> {
  const result = await context.commit({
    eventId: event.id,
    eventType: event.type,
    vendorId,
    plan: "free",
    status: "incomplete",
    ...input,
  })
  return { processed: true, duplicate: result.duplicate }
}

/**
 * Handles the six required Stripe events. Premium is activated only after the
 * subscription is fetched from Stripe and confirmed active/trialing. Replayed
 * events are handled by the atomic event marker in `commit`.
 */
export async function processStripeEvent(
  event: Stripe.Event,
  context: WebhookContext,
): Promise<WebhookResult> {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object as Stripe.Checkout.Session
      const vendorId =
        metadataVendorId(session) ??
        (typeof session.client_reference_id === "string" ? session.client_reference_id : null) ??
        (await context.vendorIdForSession(session.id))

      if (!vendorId) return { processed: false, ignored: true, reason: "vendor_not_found" }

      const stripeSubscriptionId = referenceId(session.subscription)
      const stripeCustomerId = referenceId(session.customer)

      // An asynchronous payment method has not cleared yet. Wait for
      // async_payment_succeeded instead of granting access early.
      if (session.payment_status === "unpaid") {
        return commitPending(context, event, vendorId, {
          stripeSessionId: session.id,
          stripeCustomerId,
          stripeSubscriptionId,
        })
      }

      if (!stripeSubscriptionId) {
        return commitPending(context, event, vendorId, {
          stripeSessionId: session.id,
          stripeCustomerId,
        })
      }

      const subscription = await context.retrieveSubscription(stripeSubscriptionId)
      const subscriptionVendorId = metadataVendorId(subscription)

      if (subscriptionVendorId && subscriptionVendorId !== vendorId) {
        return { processed: false, ignored: true, reason: "vendor_mismatch" }
      }

      const status: SubscriptionStatus = mapStripeSubscriptionStatus(subscription.status)
      const amount = toMajorAmount(session.amount_total ?? session.amount_subtotal, session.currency)

      const result = await context.commit({
        eventId: event.id,
        eventType: event.type,
        vendorId,
        plan: entitled(subscription.status) ? "premium" : "free",
        status,
        stripeSessionId: session.id,
        stripeCustomerId,
        stripeSubscriptionId,
        currentPeriodEnd: subscriptionPeriodEnd(subscription),
        cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
        payment: {
          amount,
          currency: (session.currency || "usd").toUpperCase(),
          stripeSessionId: session.id,
          stripeSubscriptionId,
          status: entitled(subscription.status) ? "paid" : subscription.status,
        },
      })

      return { processed: true, duplicate: result.duplicate }
    }

    case "checkout.session.async_payment_failed": {
      const session = event.data.object as Stripe.Checkout.Session
      const vendorId =
        metadataVendorId(session) ??
        (typeof session.client_reference_id === "string" ? session.client_reference_id : null) ??
        (await context.vendorIdForSession(session.id))

      if (!vendorId) return { processed: false, ignored: true, reason: "vendor_not_found" }

      const stripeSubscriptionId = referenceId(session.subscription)
      const result = await context.commit({
        eventId: event.id,
        eventType: event.type,
        vendorId,
        plan: "free",
        status: "past_due",
        stripeSessionId: session.id,
        stripeCustomerId: referenceId(session.customer),
        stripeSubscriptionId,
        payment: {
          amount: toMajorAmount(session.amount_total, session.currency),
          currency: (session.currency || "usd").toUpperCase(),
          stripeSessionId: session.id,
          stripeSubscriptionId,
          status: "failed",
        },
      })

      return { processed: true, duplicate: result.duplicate }
    }

    case "customer.subscription.updated": {
      const eventSubscription = event.data.object as Stripe.Subscription
      const vendorId = await context.vendorIdForSubscription(
        eventSubscription.id,
        metadataVendorId(eventSubscription),
      )

      if (!vendorId) return { processed: false, ignored: true, reason: "vendor_not_found" }

      // Re-read the subscription so an out-of-order or forged event cannot
      // activate Premium on its own.
      const subscription = await context.retrieveSubscription(eventSubscription.id)
      const subscriptionVendorId = metadataVendorId(subscription)

      if (subscriptionVendorId && subscriptionVendorId !== vendorId) {
        return { processed: false, ignored: true, reason: "vendor_mismatch" }
      }

      const customerId = referenceId(subscription.customer) ?? referenceId(eventSubscription.customer)
      const result = await context.commit({
        eventId: event.id,
        eventType: event.type,
        vendorId,
        plan: planFor(subscription.status),
        status: mapStripeSubscriptionStatus(subscription.status),
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscription.id,
        stripeSessionId: null,
        currentPeriodEnd: subscriptionPeriodEnd(subscription),
        cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
      })

      return { processed: true, duplicate: result.duplicate }
    }

    case "customer.subscription.deleted": {
      const eventSubscription = event.data.object as Stripe.Subscription
      const vendorId = await context.vendorIdForSubscription(
        eventSubscription.id,
        metadataVendorId(eventSubscription),
      )

      if (!vendorId) return { processed: false, ignored: true, reason: "vendor_not_found" }

      const result = await context.commit({
        eventId: event.id,
        eventType: event.type,
        vendorId,
        plan: "free",
        status: "canceled",
        stripeCustomerId: referenceId(eventSubscription.customer),
        stripeSubscriptionId: eventSubscription.id,
        currentPeriodEnd: subscriptionPeriodEnd(eventSubscription),
        cancelAtPeriodEnd: false,
      })

      return { processed: true, duplicate: result.duplicate }
    }

    case "invoice.paid": {
      const invoice = event.data.object as Stripe.Invoice
      const stripeSubscriptionId = invoiceSubscriptionId(invoice)

      if (!stripeSubscriptionId) {
        return { processed: false, ignored: true, reason: "no_subscription" }
      }

      const subscription = await context.retrieveSubscription(stripeSubscriptionId)
      const vendorId = await context.vendorIdForSubscription(
        stripeSubscriptionId,
        metadataVendorId(subscription),
      )

      if (!vendorId) return { processed: false, ignored: true, reason: "vendor_not_found" }

      const result = await context.commit({
        eventId: event.id,
        eventType: event.type,
        vendorId,
        plan: planFor(subscription.status),
        status: mapStripeSubscriptionStatus(subscription.status),
        stripeCustomerId: referenceId(subscription.customer) ?? referenceId(invoice.customer),
        stripeSubscriptionId,
        currentPeriodEnd: subscriptionPeriodEnd(subscription),
        cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
        payment: {
          amount: toMajorAmount(invoice.amount_paid ?? invoice.total, invoice.currency),
          currency: (invoice.currency || "usd").toUpperCase(),
          stripeSessionId: null,
          stripeSubscriptionId,
          status: "paid",
        },
      })

      return { processed: true, duplicate: result.duplicate }
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice
      const stripeSubscriptionId = invoiceSubscriptionId(invoice)

      if (!stripeSubscriptionId) {
        return { processed: false, ignored: true, reason: "no_subscription" }
      }

      const subscription = await context.retrieveSubscription(stripeSubscriptionId)
      const vendorId = await context.vendorIdForSubscription(
        stripeSubscriptionId,
        metadataVendorId(subscription),
      )

      if (!vendorId) return { processed: false, ignored: true, reason: "vendor_not_found" }

      const result = await context.commit({
        eventId: event.id,
        eventType: event.type,
        vendorId,
        // Follow the subscription state Stripe actually reports. A failed
        // renewal usually means `past_due` (access removed), but Stripe can still
        // report `active` during a retry grace period — do not revoke early.
        plan: planFor(subscription.status || "past_due"),
        status: mapStripeSubscriptionStatus(subscription.status || "past_due"),
        stripeCustomerId: referenceId(subscription.customer) ?? referenceId(invoice.customer),
        stripeSubscriptionId,
        currentPeriodEnd: subscriptionPeriodEnd(subscription),
        cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
        payment: {
          amount: toMajorAmount(invoice.amount_due ?? invoice.total, invoice.currency),
          currency: (invoice.currency || "usd").toUpperCase(),
          stripeSessionId: null,
          stripeSubscriptionId,
          status: "failed",
        },
      })

      return { processed: true, duplicate: result.duplicate }
    }

    default:
      return { processed: false, ignored: true, reason: "unsupported_event" }
  }
}

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type Stripe from "stripe"

import {
  CHECKOUT_RESERVATION_MS,
  checkoutClaimFilter,
  checkoutIdempotencyKey,
  withCheckoutReservation,
  type CheckoutGuardDeps,
} from "../services/checkout-guard.service.js"
import { TRANSACTION_DEDUPE_INDEX } from "../services/subscriptions.service.js"
import {
  paymentDedupeKey,
  processStripeEvent,
  type WebhookContext,
} from "../services/stripe-webhook.service.js"
import type { SubscriptionSnapshotInput } from "../types/subscription.js"

const VENDOR = "vendor-1"
const OTHER_VENDOR = "vendor-2"
const SUBSCRIPTION_ID = "sub_test"
const CUSTOMER_ID = "cus_test"

function checkoutDeps(overrides: Partial<CheckoutGuardDeps> = {}) {
  let holder: string | null = null
  let counter = 0

  const deps: CheckoutGuardDeps = {
    claim: async (_vendorId, requestId) => {
      if (holder !== null) return false
      holder = requestId
      return true
    },
    release: async (_vendorId, requestId) => {
      if (holder === requestId) holder = null
    },
    createRequestId: () => `request-${++counter}`,
    ...overrides,
  }
  return { deps, holder: () => holder }
}

function subscription(status = "active", latestInvoice = "in_123") {
  return {
    id: SUBSCRIPTION_ID,
    status,
    metadata: { vendorId: VENDOR },
    customer: CUSTOMER_ID,
    cancel_at_period_end: false,
    current_period_end: Math.floor(Date.now() / 1000) + 86_400,
    latest_invoice: latestInvoice,
    items: { data: [{ price: { id: "price_test" } }] },
  } as unknown as Stripe.Subscription
}

function sessionEvent(id: string): Stripe.Event {
  return {
    id,
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test",
        metadata: { vendorId: VENDOR },
        client_reference_id: VENDOR,
        customer: CUSTOMER_ID,
        subscription: SUBSCRIPTION_ID,
        payment_status: "paid",
        amount_total: 1999,
        currency: "usd",
      },
    },
  } as unknown as Stripe.Event
}

function invoiceEvent(id: string, invoiceId: string, type: string): Stripe.Event {
  return {
    id,
    object: "event",
    type,
    data: {
      object: {
        id: invoiceId,
        customer: CUSTOMER_ID,
        amount_paid: 1999,
        amount_due: 1999,
        total: 1999,
        currency: "usd",
        payment_intent: "pi_test",
        parent: { subscription_details: { subscription: SUBSCRIPTION_ID } },
      },
    },
  } as unknown as Stripe.Event
}

function webhookContext() {
  const payments: SubscriptionSnapshotInput[] = []
  const seenEvents = new Set<string>()
  const context: WebhookContext = {
    vendorIdForSession: async () => VENDOR,
    vendorIdForSubscription: async () => VENDOR,
    vendorIdForCustomer: async () => VENDOR,
    retrieveSubscription: async () => subscription(),
    commit: async (input) => {
      if (seenEvents.has(input.eventId)) return { duplicate: true }
      seenEvents.add(input.eventId)

      if (input.payment) {
        const key = input.payment.dedupeKey ?? `event:${input.eventId}`
        if (payments.some((item) => item.payment?.dedupeKey === key)) {
          return { duplicate: true }
        }
        payments.push(input)
      }
      return { duplicate: false }
    },
  }
  return { context, payments }
}

describe("checkout reservation and idempotency", () => {
  it("allows only one checkout per vendor, including repeated requests", async () => {
    const { deps } = checkoutDeps()
    const work = async () => "session"

    const first = await withCheckoutReservation(VENDOR, work, deps)
    const second = await withCheckoutReservation(VENDOR, work, deps)

    assert.deepEqual(first, { ok: true, value: "session" })
    assert.deepEqual(second, { ok: false, reason: "busy" })
  })

  it("admits one winner across concurrent checkout requests", async () => {
    const { deps } = checkoutDeps()
    const results = await Promise.all(
      Array.from({ length: 8 }, () => withCheckoutReservation(VENDOR, async () => "session", deps)),
    )

    assert.equal(results.filter((result) => result.ok).length, 1)
    assert.equal(results.filter((result) => !result.ok).length, 7)
  })

  it("releases the reservation when checkout creation fails", async () => {
    const { deps, holder } = checkoutDeps()

    await assert.rejects(() =>
      withCheckoutReservation(VENDOR, async () => {
        throw new Error("Stripe unavailable")
      }, deps),
    )
    assert.equal(holder(), null)

    const retry = await withCheckoutReservation(VENDOR, async () => "session", deps)
    assert.deepEqual(retry, { ok: true, value: "session" })
  })

  it("lets two vendors purchase independently", async () => {
    const deps: CheckoutGuardDeps = {
      claim: async () => true,
      release: async () => undefined,
      createRequestId: () => "id",
    }
    const results = await Promise.all(
      [VENDOR, OTHER_VENDOR].map((vendorId) =>
        withCheckoutReservation(vendorId, async () => "session", deps),
      ),
    )
    assert.deepEqual(results, [
      { ok: true, value: "session" },
      { ok: true, value: "session" },
    ])
  })

  it("excludes entitled subscriptions and live reservations in the claim filter", () => {
    const filter = checkoutClaimFilter(VENDOR, new Date()) as {
      vendorId: string
      $and: Array<{ $or: unknown[] }>
    }
    const json = JSON.stringify(filter)

    assert.equal(filter.vendorId, VENDOR)
    assert.equal(filter.$and.length, 2)
    assert.equal(json.includes('"premium"'), true)
    assert.equal(json.includes('"trialing"'), true)
    assert.equal(json.includes("currentPeriodEnd"), true)
    assert.equal(json.includes("checkoutRequestId"), true)
    assert.equal(json.includes("checkoutReservationExpiresAt"), true)
    assert.ok(CHECKOUT_RESERVATION_MS > 0)
  })

  it("reuses an idempotency key only for the same logical request", () => {
    const key = checkoutIdempotencyKey("request-1")
    assert.equal(key, checkoutIdempotencyKey("request-1"))
    assert.notEqual(key, checkoutIdempotencyKey("request-2"))
  })
})

describe("webhook transaction idempotency", () => {
  it("collapses different event types for one invoice into one payment", async () => {
    const { context, payments } = webhookContext()

    const checkout = await processStripeEvent(sessionEvent("evt_checkout"), context)
    const invoice = await processStripeEvent(
      invoiceEvent("evt_invoice", "in_123", "invoice.paid"),
      context,
    )

    assert.equal(checkout.processed, true)
    assert.equal(invoice.processed, true)
    assert.equal(invoice.duplicate, true)
    assert.equal(payments.length, 1)
    assert.equal(
      payments[0]?.payment?.dedupeKey,
      paymentDedupeKey({ invoiceId: "in_123", status: "paid" }),
    )
    assert.equal(payments[0]?.payment?.stripeInvoiceId, "in_123")
  })

  it("keeps legitimate renewals with a new invoice", async () => {
    const { context, payments } = webhookContext()

    await processStripeEvent(invoiceEvent("evt_invoice_1", "in_123", "invoice.paid"), context)
    await processStripeEvent(invoiceEvent("evt_invoice_2", "in_456", "invoice.paid"), context)

    assert.equal(payments.length, 2)
    assert.equal(payments[0]?.payment?.dedupeKey !== payments[1]?.payment?.dedupeKey, true)
  })

  it("ignores a repeated identical webhook event", async () => {
    const { context, payments } = webhookContext()
    const event = invoiceEvent("evt_repeat", "in_789", "invoice.paid")

    const first = await processStripeEvent(event, context)
    const second = await processStripeEvent(event, context)

    assert.deepEqual(first, { processed: true, duplicate: false })
    assert.deepEqual(second, { processed: true, duplicate: true })
    assert.equal(payments.length, 1)
  })

  it("separates failed payments from paid ones", () => {
    const paid = paymentDedupeKey({ invoiceId: "in_123", status: "paid" })
    const failed = paymentDedupeKey({ invoiceId: "in_123", status: "failed" })
    const refunded = paymentDedupeKey({ invoiceId: "in_123", status: "refunded" })

    assert.notEqual(paid, failed)
    assert.notEqual(paid, refunded)
    assert.equal(refunded.includes("refunded"), true)
  })

  it("uses a sparse unique index that old records do not occupy", () => {
    assert.equal(TRANSACTION_DEDUPE_INDEX.unique, true)
    assert.equal(TRANSACTION_DEDUPE_INDEX.sparse, true)
    assert.deepEqual(TRANSACTION_DEDUPE_INDEX.key, { dedupeKey: 1 })
  })
})

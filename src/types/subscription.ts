import type { ObjectId } from "mongodb"

/** Free vendors may keep at most this many active service listings. */
export const FREE_SERVICE_LIMIT = 3

export type SubscriptionPlan = "free" | "premium"

/**
 * Server-owned subscription state. Only the verified Stripe webhook may write
 * an active/premium state; the browser can never set any of these fields.
 */
export const SUBSCRIPTION_STATUSES = [
  "none",
  "incomplete",
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "incomplete_expired",
  "canceled",
  "expired",
] as const

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number]

export interface SubscriptionRecord {
  _id?: ObjectId
  vendorId: string
  plan: SubscriptionPlan
  status: SubscriptionStatus
  stripeCustomerId?: string | null
  stripeSessionId?: string | null
  stripeSubscriptionId?: string | null
  /** Short-lived atomic reservation used while a Checkout Session is created. */
  checkoutRequestId?: string
  checkoutReservationExpiresAt?: Date
  currentPeriodEnd?: Date | string | null
  cancelAtPeriodEnd?: boolean
  updatedAt: Date | string
  createdAt: Date | string
}

/** One row per payment event, written atomically with the subscription update. */
export interface PaymentTransactionRecord {
  _id?: ObjectId
  vendorId: string
  plan: SubscriptionPlan
  amount: number
  currency: string
  stripeSessionId: string | null
  stripeSubscriptionId: string | null
  status: string
  stripeEventId: string | null
  /** Stripe invoice/payment intent ids for reconciliation. Absent on old rows. */
  stripeInvoiceId?: string | null
  stripePaymentIntentId?: string | null
  /** Unique per logical payment; blocks different events for one invoice. */
  dedupeKey?: string
  createdAt: Date | string
}

/** Idempotency marker: one document per processed Stripe event id. */
export interface StripeEventRecord {
  _id: string
  type: string
  createdAt: Date
}

/** The complete state change produced by one verified Stripe event. */
export interface SubscriptionSnapshotInput {
  eventId: string
  eventType: string
  vendorId: string
  plan: SubscriptionPlan
  status: SubscriptionStatus
  stripeCustomerId?: string | null
  stripeSubscriptionId?: string | null
  stripeSessionId?: string | null
  currentPeriodEnd?: Date | null
  cancelAtPeriodEnd?: boolean
  payment?: {
    amount: number
    currency: string
    stripeSessionId: string | null
    stripeSubscriptionId: string | null
    status: string
    dedupeKey?: string
    stripeInvoiceId?: string | null
    stripePaymentIntentId?: string | null
  } | null
}

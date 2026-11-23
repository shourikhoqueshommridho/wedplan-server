import type { ClientSession, Filter } from "mongodb"
import type Stripe from "stripe"

import { getDb, withMongoTransaction } from "../lib/mongodb.js"
import {
  FREE_SERVICE_LIMIT,
  type PaymentTransactionRecord,
  type SubscriptionPlan,
  type SubscriptionRecord,
  type SubscriptionSnapshotInput,
  type SubscriptionStatus,
  type StripeEventRecord,
} from "../types/subscription.js"

const SUBSCRIPTION_COLLECTION = "subscriptions"
const TRANSACTION_COLLECTION = "transactions"
const EVENT_COLLECTION = "stripe_events"

/** One paid/failed row per logical payment, even across different events. */
export const TRANSACTION_DEDUPE_INDEX = {
  key: { dedupeKey: 1 },
  name: "transaction_dedupe_unique",
  unique: true,
  sparse: true,
} as const

let indexPromise: Promise<void> | null = null

/** Zero-decimal currencies must not be divided by 100. */
const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
])

export interface SubscriptionStatusResponse {
  plan: SubscriptionPlan
  status: SubscriptionStatus
  active: boolean
  renewalDate: string | null
  cancelAtPeriodEnd: boolean
  serviceLimit: number | null
  activeServiceCount: number
  canCreateService: boolean
  stripeSessionId: string | null
  stripeSubscriptionId: string | null
  lastPayment: {
    status: string
    amount: number
    currency: string
    createdAt: string | null
  } | null
}

export function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === "number") {
    const date = new Date(value * 1000)
    return Number.isNaN(date.getTime()) ? null : date
  }
  if (typeof value === "string") {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
  }
  return null
}

function toIso(value: unknown): string | null {
  return toDate(value)?.toISOString() ?? null
}

/** Maps a Stripe status to the server-owned status vocabulary. */
export function mapStripeSubscriptionStatus(status: string): SubscriptionStatus {
  switch (status) {
    case "active": return "active"
    case "trialing": return "trialing"
    case "past_due": return "past_due"
    case "unpaid": return "unpaid"
    case "incomplete": return "incomplete"
    case "incomplete_expired": return "incomplete_expired"
    case "canceled": return "canceled"
    case "expired": return "expired"
    default: return "incomplete"
  }
}

/**
 * Premium access is granted only for a verified, currently valid Stripe
 * subscription. A stale "premium" flag alone never grants access.
 */
export function isPremiumEntitled(
  record: Pick<SubscriptionRecord, "plan" | "status" | "currentPeriodEnd"> | null,
  now: Date = new Date(),
): boolean {
  if (!record) return false
  if (record.plan !== "premium") return false
  if (record.status !== "active" && record.status !== "trialing") return false

  const periodEnd = toDate(record.currentPeriodEnd)
  return periodEnd === null || periodEnd.getTime() > now.getTime()
}

export function effectivePlan(
  record: Pick<SubscriptionRecord, "plan" | "status" | "currentPeriodEnd"> | null,
  now: Date = new Date(),
): SubscriptionPlan {
  return isPremiumEntitled(record, now) ? "premium" : "free"
}

export function canCreateActiveService(plan: SubscriptionPlan, activeCount: number): boolean {
  return plan === "premium" || activeCount < FREE_SERVICE_LIMIT
}

/**
 * Blocked/delinququent account detection. Supports the most common flags used
 * by admin tooling. Unknown shapes are treated as not blocked so a schema
 * change can never lock out every vendor by accident.
 */
export function isBlockedUser(document: unknown): boolean {
  if (!document || typeof document !== "object") return false
  const user = document as Record<string, unknown>

  return (
    user.blocked === true ||
    user.isBlocked === true ||
    user.banned === true ||
    user.suspended === true ||
    user.status === "blocked" ||
    user.status === "banned" ||
    user.status === "suspended" ||
    user.accountStatus === "blocked"
  )
}

export function toMajorAmount(
  amount: number | null | undefined,
  currency: string | null | undefined,
): number {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return 0
  const code = (currency || "usd").toUpperCase()
  return ZERO_DECIMAL_CURRENCIES.has(code) ? amount : Math.round(amount) / 100
}

/** Stripe may expose period end at the subscription or on its first item. */
export function subscriptionPeriodEnd(subscription: Stripe.Subscription): Date | null {
  const topLevel = (subscription as unknown as Record<string, unknown>).current_period_end
  const firstItem = (
    subscription as unknown as {
      items?: { data?: Array<Record<string, unknown>> }
    }
  ).items?.data?.[0]?.current_period_end

  return toDate(topLevel) ?? toDate(firstItem)
}

function subscriptionId(subscription: Stripe.Subscription): string | null {
  return subscription.id || null
}

export async function ensureIndexes(): Promise<void> {
  indexPromise ??= (async () => {
    const db = await getDb()
    await Promise.all([
      db.collection<SubscriptionRecord>(SUBSCRIPTION_COLLECTION).createIndex(
        { vendorId: 1 },
        { unique: true, name: "subscription_vendor_unique" },
      ),
      db.collection<SubscriptionRecord>(SUBSCRIPTION_COLLECTION).createIndex(
        { checkoutRequestId: 1 },
        { unique: true, sparse: true, name: "subscription_checkout_request_unique" },
      ),
      db.collection<PaymentTransactionRecord>(TRANSACTION_COLLECTION).createIndex(
        { stripeEventId: 1 },
        { unique: true, sparse: true, name: "transaction_event_unique" },
      ),
      db.collection<PaymentTransactionRecord>(TRANSACTION_COLLECTION).createIndex(
        { vendorId: 1, createdAt: -1 },
        { name: "transaction_vendor_recent" },
      ),
      db.collection<PaymentTransactionRecord>(TRANSACTION_COLLECTION).createIndex(
        { ...TRANSACTION_DEDUPE_INDEX.key },
        {
          name: TRANSACTION_DEDUPE_INDEX.name,
          unique: TRANSACTION_DEDUPE_INDEX.unique,
          sparse: TRANSACTION_DEDUPE_INDEX.sparse,
        },
      ),
    ])
  })().catch((error: unknown) => {
    indexPromise = null
    throw error
  })

  return indexPromise
}

export async function getSubscription(vendorId: string): Promise<SubscriptionRecord | null> {
  const db = await getDb()
  return db.collection<SubscriptionRecord>(SUBSCRIPTION_COLLECTION).findOne({ vendorId })
}

export async function getSubscriptionBySession(
  sessionId: string,
): Promise<SubscriptionRecord | null> {
  const db = await getDb()
  return db.collection<SubscriptionRecord>(SUBSCRIPTION_COLLECTION).findOne({
    stripeSessionId: sessionId,
  })
}

export async function getSubscriptionByStripeSubscriptionId(
  stripeSubscriptionId: string,
): Promise<SubscriptionRecord | null> {
  const db = await getDb()
  return db.collection<SubscriptionRecord>(SUBSCRIPTION_COLLECTION).findOne({
    stripeSubscriptionId,
  })
}

export async function getSubscriptionByCustomer(
  customerId: string,
): Promise<SubscriptionRecord | null> {
  const db = await getDb()
  return db.collection<SubscriptionRecord>(SUBSCRIPTION_COLLECTION).findOne({
    stripeCustomerId: customerId,
  })
}

/**
 * Records that a Checkout Session was created. This never sets an active or
 * premium state — only the verified webhook can do that.
 */
export async function markCheckoutPending(
  vendorId: string,
  stripeSessionId: string,
  stripeCustomerId: string | null,
): Promise<void> {
  await ensureIndexes()
  const db = await getDb()
  const now = new Date()

  await db.collection<SubscriptionRecord>(SUBSCRIPTION_COLLECTION).updateOne(
    { vendorId },
    {
      $set: {
        status: "incomplete",
        stripeSessionId,
        ...(stripeCustomerId ? { stripeCustomerId } : {}),
        updatedAt: now,
      },
      $setOnInsert: {
        vendorId,
        plan: "free",
        createdAt: now,
      },
    },
    { upsert: true },
  )
}

export async function getActiveServiceCount(vendorId: string): Promise<number> {
  const db = await getDb()
  return db.collection<{ vendorId: string; isActive: boolean }>("services").countDocuments({
    vendorId,
    isActive: true,
  })
}

export async function assertCanCreateActiveService(vendorId: string): Promise<{
  allowed: boolean
  plan: SubscriptionPlan
  activeCount: number
  limit: number | null
}> {
  const [record, activeCount] = await Promise.all([
    getSubscription(vendorId),
    getActiveServiceCount(vendorId),
  ])
  const plan = effectivePlan(record)
  const limit = plan === "premium" ? null : FREE_SERVICE_LIMIT

  return { allowed: canCreateActiveService(plan, activeCount), plan, activeCount, limit }
}

/** Pure snapshot builder so the GET response can be tested without MongoDB. */
export function buildSubscriptionSnapshot(
  record: SubscriptionRecord | null,
  activeServiceCount: number,
  lastTransaction: PaymentTransactionRecord | null = null,
): SubscriptionStatusResponse {
  const plan = effectivePlan(record)

  return {
    plan,
    status: record?.status ?? "none",
    active: plan === "premium",
    renewalDate: toIso(record?.currentPeriodEnd),
    cancelAtPeriodEnd: record?.cancelAtPeriodEnd === true,
    serviceLimit: plan === "premium" ? null : FREE_SERVICE_LIMIT,
    activeServiceCount,
    canCreateService: canCreateActiveService(plan, activeServiceCount),
    stripeSessionId: record?.stripeSessionId ?? null,
    stripeSubscriptionId: record?.stripeSubscriptionId ?? null,
    lastPayment: lastTransaction
      ? {
          status: lastTransaction.status,
          amount: lastTransaction.amount,
          currency: lastTransaction.currency,
          createdAt: toIso(lastTransaction.createdAt),
        }
      : null,
  }
}

export async function getSubscriptionSnapshot(
  vendorId: string,
): Promise<SubscriptionStatusResponse> {
  const [record, activeServiceCount] = await Promise.all([
    getSubscription(vendorId),
    getActiveServiceCount(vendorId),
  ])
  const db = await getDb()
  const lastTransaction = await db
    .collection<PaymentTransactionRecord>(TRANSACTION_COLLECTION)
    .findOne({ vendorId }, { sort: { createdAt: -1 } })

  return buildSubscriptionSnapshot(record, activeServiceCount, lastTransaction)
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "MongoServerError" || error.message.includes("E11000")) &&
    (error as { code?: number }).code === 11000
  )
}

/**
 * Atomically marks one Stripe event as processed, updates the vendor's
 * subscription and writes a payment transaction. Replaying the same event is a
 * no-op: either the marker exists already or the unique index rejects it.
 */
export async function commitSubscriptionSnapshot(
  input: SubscriptionSnapshotInput,
): Promise<{ duplicate: boolean }> {
  await ensureIndexes()
  const db = await getDb()
  const events = db.collection<StripeEventRecord>(EVENT_COLLECTION)

  if (await events.findOne({ _id: input.eventId })) {
    return { duplicate: true }
  }

  try {
    await withMongoTransaction(async (session: ClientSession) => {
      await events.insertOne(
        { _id: input.eventId, type: input.eventType, createdAt: new Date() },
        { session },
      )

      const now = new Date()
      const set: Record<string, unknown> = {
        plan: input.plan,
        status: input.status,
        stripeSubscriptionId: input.stripeSubscriptionId ?? null,
        cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? false,
        updatedAt: now,
      }
      // Later events must not erase the Checkout Session id recorded earlier.
      if (input.stripeSessionId) set.stripeSessionId = input.stripeSessionId
      if (input.stripeCustomerId) set.stripeCustomerId = input.stripeCustomerId
      if (input.currentPeriodEnd) set.currentPeriodEnd = input.currentPeriodEnd

      await db.collection<SubscriptionRecord>(SUBSCRIPTION_COLLECTION).updateOne(
        { vendorId: input.vendorId },
        {
          $set: set,
          $setOnInsert: { vendorId: input.vendorId, createdAt: now },
        },
        { upsert: true, session },
      )

      if (input.payment) {
        await db.collection<PaymentTransactionRecord>(TRANSACTION_COLLECTION).insertOne(
          {
            vendorId: input.vendorId,
            plan: input.plan,
            amount: input.payment.amount,
            currency: input.payment.currency.toUpperCase(),
            stripeSessionId: input.payment.stripeSessionId,
            stripeSubscriptionId: input.payment.stripeSubscriptionId,
            status: input.payment.status,
            stripeEventId: input.eventId,
            stripeInvoiceId: input.payment.stripeInvoiceId ?? null,
            stripePaymentIntentId: input.payment.stripePaymentIntentId ?? null,
            dedupeKey: input.payment.dedupeKey ?? `event:${input.eventId}`,
            createdAt: now,
          },
          { session },
        )
      }
    })

    return { duplicate: false }
  } catch (error) {
    if (isDuplicateKeyError(error)) return { duplicate: true }
    throw error
  }
}

/** Used by the status endpoint to detect an abandoned Checkout Session. */
export function isCheckoutSessionOpen(session: {
  status: string | null | undefined
  expires_at?: number | null
}): boolean {
  if (session.status !== "open") return false
  if (typeof session.expires_at !== "number") return true
  return session.expires_at * 1000 > Date.now()
}

export function subscriptionFilter(vendorId: string): Filter<SubscriptionRecord> {
  return { vendorId }
}

export { subscriptionId }

import { randomUUID } from "node:crypto"
import type { Filter } from "mongodb"

import { getDb } from "../lib/mongodb.js"
import type { SubscriptionRecord } from "../types/subscription.js"
import { ensureIndexes } from "./subscriptions.service.js"

export const CHECKOUT_RESERVATION_MS = 10 * 60 * 1000

export interface CheckoutReservation {
  requestId: string
  idempotencyKey: string
  expiresAt: Date
}

/** Injected so concurrent checkout tests run without a database. */
export interface CheckoutGuardDeps {
  claim(
    vendorId: string,
    requestId: string,
    expiresAt: Date,
  ): Promise<boolean>
  release(vendorId: string, requestId: string): Promise<void>
  createRequestId(): string
}

/** Pure filter used by the atomic claim; exported for verification. */
export function checkoutClaimFilter(vendorId: string, now: Date): Filter<SubscriptionRecord> {
  return {
    vendorId,
    $and: [
      {
        $or: [
          { plan: { $ne: "premium" } },
          { status: { $nin: ["active", "trialing"] } },
          { currentPeriodEnd: { $lt: now } },
        ],
      },
      {
        $or: [
          { checkoutRequestId: { $exists: false } },
          { checkoutReservationExpiresAt: { $lt: now } },
        ],
      },
    ],
  } as Filter<SubscriptionRecord>
}

const defaultDeps: CheckoutGuardDeps = {
  claim: async (vendorId, requestId, expiresAt) => {
    await ensureIndexes()
    const db = await getDb()
    const now = new Date()
    try {
      const result = await db
        .collection<SubscriptionRecord>("subscriptions")
        .findOneAndUpdate(
          checkoutClaimFilter(vendorId, now),
          {
            $set: {
              checkoutRequestId: requestId,
              checkoutReservationExpiresAt: expiresAt,
              updatedAt: now,
            },
            $setOnInsert: {
              vendorId,
              plan: "free",
              status: "incomplete",
              createdAt: now,
            },
          },
          { upsert: true },
        )
      return result !== null
    } catch (error) {
      // Two instances racing an upsert: the unique vendor index rejects one.
      if (
        error instanceof Error &&
        error.name === "MongoServerError" &&
        (error as { code?: number }).code === 11000
      ) {
        return false
      }
      throw error
    }
  },

  release: async (vendorId, requestId) => {
    const db = await getDb()
    await db.collection<SubscriptionRecord>("subscriptions").updateOne(
      { vendorId, checkoutRequestId: requestId },
      {
        $unset: {
          checkoutRequestId: "",
          checkoutReservationExpiresAt: "",
        },
      },
    )
  },

  createRequestId: () => randomUUID(),
}

/** A new request id yields a new key; retries of one request reuse it. */
export function checkoutIdempotencyKey(requestId: string): string {
  return `wedplan-checkout-${requestId}`
}

export type CheckoutGuardResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "busy" }

/**
 * Atomically claims one short-lived checkout reservation per vendor. The claim
 * condition covers both an entitled subscription and an in-flight checkout, so
 * concurrent requests cannot create a second Checkout Session.
 */
export async function withCheckoutReservation<T>(
  vendorId: string,
  work: (reservation: CheckoutReservation) => Promise<T>,
  deps: CheckoutGuardDeps = defaultDeps,
): Promise<CheckoutGuardResult<T>> {
  const requestId = deps.createRequestId()
  const expiresAt = new Date(Date.now() + CHECKOUT_RESERVATION_MS)
  const claimed = await deps.claim(vendorId, requestId, expiresAt)

  if (!claimed) return { ok: false, reason: "busy" }

  try {
    return {
      ok: true,
      value: await work({ requestId, expiresAt, idempotencyKey: checkoutIdempotencyKey(requestId) }),
    }
  } catch (error) {
    await deps.release(vendorId, requestId)
    throw error
  }
}

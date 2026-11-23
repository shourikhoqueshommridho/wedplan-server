import type { Document, IndexDescription, IndexSpecification } from "mongodb"

import { getDb } from "./mongodb.js"

/** Minimal surface needed for the safety check, also used by unit tests. */
export interface IndexCollectionLike {
  indexes(): Promise<Array<{ key: Document }>>
  createIndex(spec: IndexSpecification, options: Omit<IndexDescription, "key">): Promise<string>
}

function sameKeys(left: Document, right: IndexSpecification): boolean {
  const keys = Object.keys(right)
  if (keys.length !== Object.keys(left).length) return false
  return keys.every((key) => (left as Record<string, unknown>)[key] === (right as Record<string, unknown>)[key])
}

/**
 * Idempotent and non-destructive: an equivalent key pattern under a different
 * name is left untouched instead of creating a duplicate index.
 */
export async function ensureIndex(
  collection: IndexCollectionLike,
  spec: IndexSpecification,
  options: Omit<IndexDescription, "key">,
): Promise<void> {
  const existing = await collection.indexes()
  if (existing.some((index) => sameKeys(index.key, spec))) return
  await collection.createIndex(spec, options)
}

interface IndexPlan {
  collection: string
  spec: IndexSpecification
  options: Omit<IndexDescription, "key">
}

/**
 * Each entry maps to a query actually used by the API:
 * - users_role_created: admin user list/overview role counts, sorted by createdAt.
 * - services_public_listing: public approved+active listing sorted by price.
 * - services_vendor_created: vendor dashboard listing for one vendor.
 * - services_vendor_active: getActiveServiceCount / quota evaluation.
 * - bookings_customer_recent / bookings_vendor_recent: scoped booking lists.
 * - bookings_duplicate_lookup: legacy active-duplicate pre-check.
 * - bookings_status: admin overview status counts.
 * - transactions_status: admin overview paid/revenue aggregation.
 * - transactions_recent: admin transactions page (all vendors, newest first).
 * - subscription stripe lookups: webhook resolution by session/subscription/customer.
 *
 * Existing unique and partial indexes are deliberately not recreated here.
 */
export const INDEX_PLAN: readonly IndexPlan[] = [
  {
    collection: "users",
    spec: { role: 1, createdAt: -1 },
    options: { name: "users_role_created" },
  },
  {
    collection: "services",
    spec: { status: 1, isActive: 1, price: 1 },
    options: { name: "services_public_listing" },
  },
  {
    collection: "services",
    spec: { vendorId: 1, createdAt: -1 },
    options: { name: "services_vendor_created" },
  },
  {
    collection: "services",
    spec: { vendorId: 1, isActive: 1 },
    options: { name: "services_vendor_active" },
  },
  {
    collection: "bookings",
    spec: { customerId: 1, createdAt: -1 },
    options: { name: "bookings_customer_recent" },
  },
  {
    collection: "bookings",
    spec: { vendorId: 1, createdAt: -1 },
    options: { name: "bookings_vendor_recent" },
  },
  {
    collection: "bookings",
    spec: { customerId: 1, serviceId: 1, eventDate: 1, status: 1 },
    options: { name: "bookings_duplicate_lookup" },
  },
  {
    collection: "bookings",
    spec: { status: 1 },
    options: { name: "bookings_status" },
  },
  {
    collection: "transactions",
    spec: { status: 1 },
    options: { name: "transactions_status" },
  },
  {
    collection: "transactions",
    spec: { createdAt: -1 },
    options: { name: "transactions_recent" },
  },
  {
    collection: "subscriptions",
    spec: { stripeSessionId: 1 },
    options: { name: "subscription_session_lookup", sparse: true },
  },
  {
    collection: "subscriptions",
    spec: { stripeSubscriptionId: 1 },
    options: { name: "subscription_stripe_lookup", sparse: true },
  },
  {
    collection: "subscriptions",
    spec: { stripeCustomerId: 1 },
    options: { name: "subscription_customer_lookup", sparse: true },
  },
]

let indexPromise: Promise<void> | null = null

/** Safe to call on every process start and from request paths. */
export function ensureDatabaseIndexes(): Promise<void> {
  indexPromise ??= (async () => {
    const db = await getDb()
    for (const plan of INDEX_PLAN) {
      await ensureIndex(
        db.collection<Document>(plan.collection),
        plan.spec,
        plan.options,
      )
    }
  })().catch((error: unknown) => {
    // A transient failure must not permanently poison the cached promise.
    indexPromise = null
    throw error
  })

  return indexPromise
}

import type { Filter } from "mongodb"

import { getDb } from "../lib/mongodb.js"
import { FREE_SERVICE_LIMIT, type SubscriptionPlan } from "../types/subscription.js"
import type { ServiceRecord } from "../types/service.js"
import { effectivePlan, getSubscription } from "./subscriptions.service.js"

/**
 * Unique reservation slots live on the service documents themselves. A partial
 * index (rather than `sparse`) is required because a compound sparse index
 * would still include every service with a `vendorId`.
 */
export const SERVICE_QUOTA_INDEX = {
  key: { vendorId: 1, quotaSlot: 1 },
  name: "services_vendor_quota_slot_unique",
  unique: true,
  partialFilterExpression: { quotaSlot: { $type: "number" } },
} as const

let indexPromise: Promise<void> | null = null

/** Idempotent; recreated if a previous attempt failed. No existing data is changed. */
export async function ensureServiceQuotaIndexes(): Promise<void> {
  indexPromise ??= (async () => {
    const db = await getDb()
    await db.collection<ServiceRecord>("services").createIndex(
      { ...SERVICE_QUOTA_INDEX.key },
      {
        name: SERVICE_QUOTA_INDEX.name,
        unique: SERVICE_QUOTA_INDEX.unique,
        partialFilterExpression: { ...SERVICE_QUOTA_INDEX.partialFilterExpression },
      },
    )
  })().catch((error: unknown) => {
    indexPromise = null
    throw error
  })

  return indexPromise
}

export function isQuotaDuplicateKeyError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "MongoServerError" &&
    (error as { code?: number }).code === 11000
  )
}

export interface ActiveSlotDocument {
  _id: unknown
  quotaSlot?: number
}

/** Injectable for concurrency tests that do not use MongoDB. */
export interface ServiceSlotDeps {
  getPlan(vendorId: string): Promise<SubscriptionPlan>
  findActive(vendorId: string): Promise<ActiveSlotDocument[]>
  assignSlot(id: unknown, slot: number): Promise<boolean>
}

const defaultDeps: ServiceSlotDeps = {
  getPlan: async (vendorId) => effectivePlan(await getSubscription(vendorId)),
  findActive: async (vendorId) => {
    await ensureServiceQuotaIndexes()
    const db = await getDb()
    return db
      .collection<ActiveSlotDocument>("services")
      .find(
        { vendorId, isActive: true },
        { projection: { _id: 1, quotaSlot: 1 } },
      )
      .sort({ createdAt: 1, _id: 1 })
      .toArray()
  },
  assignSlot: async (id, slot) => {
    await ensureServiceQuotaIndexes()
    const db = await getDb()
    const filter = { _id: id, quotaSlot: { $exists: false } } as Filter<ActiveSlotDocument>
    const result = await db.collection<ActiveSlotDocument>("services").updateOne(filter, {
      $set: { quotaSlot: slot },
    })
    return result.matchedCount > 0
  },
}

export interface SlotPreparation {
  /** `null` means premium (unlimited); no slot is reserved. */
  slot: number | null
}

function firstFreeSlot(used: ReadonlySet<number>): number | null {
  for (let slot = 1; slot <= FREE_SERVICE_LIMIT; slot += 1) {
    if (!used.has(slot)) return slot
  }
  return null
}

/**
 * Reconciles legacy active services (which have no slot yet) by assigning them
 * free slots, then returns an unused slot for the pending activation. Existing
 * active services are always counted, so a vendor already at the limit cannot
 * gain capacity through reconciliation. Conflicts from other instances cause a
 * bounded re-read instead of relying on a process-local lock.
 */
export async function prepareServiceSlot(
  vendorId: string,
  deps: ServiceSlotDeps = defaultDeps,
): Promise<SlotPreparation | null> {
  if ((await deps.getPlan(vendorId)) === "premium") return { slot: null }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const active = await deps.findActive(vendorId)
    if (active.length >= FREE_SERVICE_LIMIT) return null

    const used = new Set<number>()
    let conflict = false

    for (const document of active) {
      const slot = document.quotaSlot
      if (typeof slot === "number" && Number.isInteger(slot) && slot >= 1 && slot <= FREE_SERVICE_LIMIT) {
        used.add(slot)
        continue
      }

      const free = firstFreeSlot(used)
      if (free === null) {
        conflict = true
        break
      }

      try {
        if (!(await deps.assignSlot(document._id, free))) {
          conflict = true
          break
        }
      } catch (error) {
        if (!isQuotaDuplicateKeyError(error)) throw error
        // Another instance took the slot between our read and the write.
        conflict = true
        break
      }
      used.add(free)
    }

    if (conflict) continue

    const slot = firstFreeSlot(used)
    return slot === null ? null : { slot }
  }

  return null
}

/** Used with `$unset` when a service is deactivated, deleted or not approved. */
export const SLOT_UNSET = { quotaSlot: "" } as const

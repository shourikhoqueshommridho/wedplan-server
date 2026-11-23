import { ObjectId, type Filter } from "mongodb"

import { getDb } from "../lib/mongodb.js"
import { isWithinServiceLimit, withServiceQuotaLock } from "./service-quota.service.js"
import { assertCanCreateActiveService } from "./subscriptions.service.js"
import type { SubscriptionPlan } from "../types/subscription.js"

export type ApprovalStatus = "approved" | "rejected"

interface ApprovableService {
  vendorId: string
  isActive: boolean
  status: string
}

export interface ApprovalQuota {
  allowed: boolean
  plan: SubscriptionPlan
  activeCount: number
  limit: number | null
}

/** Injected so the quota bypass can be tested without a database. */
export interface ApprovalDeps {
  findService(id: string): Promise<ApprovableService | null>
  updateService(
    id: string,
    values: { status: string; isActive: boolean },
  ): Promise<boolean>
  evaluateQuota(vendorId: string): Promise<ApprovalQuota>
  withLock<T>(vendorId: string, work: () => Promise<T>): Promise<T>
}

export type ApprovalResult =
  | { ok: true }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "quota"; quota: ApprovalQuota }

/**
 * Approvals share the service-quota lock with creation/reactivation so the
 * three paths cannot race each other. Kept as an alias for existing callers.
 */
export const withApprovalLock = withServiceQuotaLock

function serviceIdFilter(id: string): Filter<ApprovableService> {
  return { $or: [{ _id: id }, { _id: new ObjectId(id) }] } as Filter<ApprovableService>
}

const defaultDeps: ApprovalDeps = {
  findService: async (id) => {
    const db = await getDb()
    return db.collection<ApprovableService>("services").findOne(serviceIdFilter(id))
  },

  updateService: async (id, values) => {
    const db = await getDb()
    const result = await db.collection<ApprovableService>("services").updateOne(
      serviceIdFilter(id),
      { $set: { ...values, updatedAt: new Date() } },
    )
    return result.matchedCount > 0
  },

  evaluateQuota: assertCanCreateActiveService,
  withLock: withApprovalLock,
}

/**
 * Approves a service without letting an admin activate a fourth service for a
 * Free Plan vendor. The quota is checked before and after the write, and the
 * write is serialized per vendor, so an already-active service (a status-only
 * approval) does not consume a new slot and Premium remains unlimited.
 */
export async function approveService(
  id: string,
  status: ApprovalStatus,
  deps: ApprovalDeps = defaultDeps,
): Promise<ApprovalResult> {
  const existing = await deps.findService(id)
  if (!existing) return { ok: false, reason: "not_found" }

  const willActivate = status === "approved" && existing.isActive !== true

  return deps.withLock(existing.vendorId, async () => {
    if (willActivate) {
      const before = await deps.evaluateQuota(existing.vendorId)
      if (!before.allowed) return { ok: false, reason: "quota", quota: before }
    }

    const updated = await deps.updateService(id, {
      status,
      isActive: status === "approved",
    })
    if (!updated) return { ok: false, reason: "not_found" }

    if (willActivate) {
      // Re-check after the write: if a concurrent activation pushed the vendor
      // over the limit, undo this one instead of leaving the quota exceeded.
      const after = await deps.evaluateQuota(existing.vendorId)
      if (!isWithinServiceLimit(after)) {
        await deps.updateService(id, {
          status: existing.status,
          isActive: existing.isActive,
        })
        return { ok: false, reason: "quota", quota: after }
      }
    }

    return { ok: true }
  })
}

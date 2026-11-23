import type { Filter } from "mongodb"

import { idFilter } from "../lib/object-id.js"
import { getDb } from "../lib/mongodb.js"
import { SLOT_UNSET } from "./service-quota-db.service.js"
import {
  isWithinServiceLimit,
  withQuotaGuard,
  withServiceQuotaLock,
  type QuotaGuardDeps,
} from "./service-quota.service.js"
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
    values: { status: string; isActive: boolean; quotaSlot?: number },
  ): Promise<boolean>
  evaluateQuota(vendorId: string): Promise<ApprovalQuota>
  withLock<T>(vendorId: string, work: () => Promise<T>): Promise<T>
  prepareSlot?(vendorId: string): Promise<{ slot: number | null } | null>
  isDuplicateReservationError?(error: unknown): boolean
}

export type ApprovalResult =
  | { ok: true }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "quota"; quota: ApprovalQuota }

/**
 * Approvals share the service-quota lock with creation/reactivation. The lock
 * is only a fast path; the unique `quotaSlot` index enforces the limit across
 * backend instances. Kept as an alias for existing callers.
 */
export const withApprovalLock = withServiceQuotaLock

function serviceIdFilter(id: string): Filter<ApprovableService> {
  return idFilter<ApprovableService>(id)
}

const defaultDeps: ApprovalDeps = {
  findService: async (id) => {
    const db = await getDb()
    return db.collection<ApprovableService>("services").findOne(serviceIdFilter(id))
  },

  updateService: async (id, values) => {
    const db = await getDb()
    const set: Record<string, unknown> = { ...values, updatedAt: new Date() }
    const update: Record<string, unknown> = { $set: set }
    // Any deactivation releases a free-plan slot.
    if (values.isActive === false) update.$unset = SLOT_UNSET

    const result = await db.collection<ApprovableService>("services").updateOne(
      serviceIdFilter(id),
      update,
    )
    return result.matchedCount > 0
  },

  evaluateQuota: assertCanCreateActiveService,
  withLock: withApprovalLock,
}

/**
 * Approves a service without letting an admin activate a fourth service for a
 * Free Plan vendor. Activation writes a database-reserved slot; status-only
 * approvals and rejections never consume a new slot.
 */
export async function approveService(
  id: string,
  status: ApprovalStatus,
  deps: ApprovalDeps = defaultDeps,
): Promise<ApprovalResult> {
  const existing = await deps.findService(id)
  if (!existing) return { ok: false, reason: "not_found" }

  const willActivate = status === "approved" && existing.isActive !== true

  if (!willActivate) {
    const updated = await deps.updateService(id, {
      status,
      isActive: status === "approved",
    })
    return updated ? { ok: true } : { ok: false, reason: "not_found" }
  }

  const guardDeps: QuotaGuardDeps = {
    evaluateQuota: (vendorId) => deps.evaluateQuota(vendorId),
    withLock: (vendorId, work) => deps.withLock(vendorId, work),
    prepare: deps.prepareSlot,
    isDuplicateReservationError: deps.isDuplicateReservationError,
  }

  const guard = await withQuotaGuard(
    existing.vendorId,
    async ({ slot }) => ({
      ok: await deps.updateService(id, {
        status,
        isActive: true,
        ...(slot === null ? {} : { quotaSlot: slot }),
      }),
    }),
    async (result) => {
      if (result.ok) {
        await deps.updateService(id, {
          status: existing.status,
          isActive: existing.isActive,
        })
      }
    },
    guardDeps,
  )

  if (!guard.ok) return { ok: false, reason: "quota", quota: guard.quota as ApprovalQuota }
  if (!guard.value.ok) return { ok: false, reason: "not_found" }
  return { ok: true }
}

/** Re-exported for callers/tests that check the post-write limit directly. */
export { isWithinServiceLimit }

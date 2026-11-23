import type { SubscriptionPlan } from "../types/subscription.js"
import {
  isQuotaDuplicateKeyError,
  prepareServiceSlot,
} from "./service-quota-db.service.js"
import { assertCanCreateActiveService } from "./subscriptions.service.js"

export interface ServiceQuota {
  allowed: boolean
  plan: SubscriptionPlan
  activeCount: number
  limit: number | null
}

/**
 * Process-local lock retained as a fast path to reduce contention. Safety no
 * longer depends on it: the unique `quotaSlot` index is enforced by MongoDB
 * across every backend instance.
 */
const quotaLocks = new Map<string, Promise<void>>()

export async function withServiceQuotaLock<T>(
  vendorId: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = quotaLocks.get(vendorId) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => gate)
  quotaLocks.set(vendorId, tail)

  await previous
  try {
    return await work()
  } finally {
    release()
    if (quotaLocks.get(vendorId) === tail) quotaLocks.delete(vendorId)
  }
}

export interface QuotaContext {
  /** Free-plan slot to write with the activation; `null` for unlimited plans. */
  slot: number | null
}

/** Injected so quota behavior can be tested without MongoDB. */
export interface QuotaGuardDeps {
  evaluateQuota(vendorId: string): Promise<ServiceQuota>
  withLock<T>(vendorId: string, work: () => Promise<T>): Promise<T>
  prepare?(vendorId: string): Promise<{ slot: number | null } | null>
  isDuplicateReservationError?(error: unknown): boolean
}

/**
 * `allowed` means "can create another" (count < limit). After a write the
 * correct test is "is still within the limit" (count <= limit), otherwise the
 * legitimate third service would be rolled back.
 */
export function isWithinServiceLimit(quota: ServiceQuota): boolean {
  return quota.limit === null || quota.activeCount <= quota.limit
}

export type QuotaGuardResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "quota"; quota: ServiceQuota }

const defaultDeps: QuotaGuardDeps = {
  evaluateQuota: assertCanCreateActiveService,
  withLock: withServiceQuotaLock,
  prepare: prepareServiceSlot,
  isDuplicateReservationError: isQuotaDuplicateKeyError,
}

/**
 * Runs an activation with a database-level slot reservation. The candidate slot
 * is computed from real active services (including legacy records) and written
 * atomically by `work`; a unique index rejects competing reservations, and the
 * bounded retry re-reads state before trying another slot.
 */
export async function withQuotaGuard<T>(
  vendorId: string,
  work: (context: QuotaContext) => Promise<T>,
  rollback: (value: T) => Promise<void>,
  deps: QuotaGuardDeps = defaultDeps,
): Promise<QuotaGuardResult<T>> {
  return deps.withLock(vendorId, async () => {
    const before = await deps.evaluateQuota(vendorId)
    if (!before.allowed) return { ok: false, reason: "quota", quota: before }

    let value!: T

    if (!deps.prepare || !deps.isDuplicateReservationError) {
      value = await work({ slot: null })
    } else {
      for (let attempt = 0; ; attempt += 1) {
        const reservation = await deps.prepare(vendorId)
        if (!reservation) {
          const quota = await deps.evaluateQuota(vendorId)
          return { ok: false, reason: "quota", quota }
        }

        try {
          value = await work({ slot: reservation.slot })
          break
        } catch (error) {
          if (attempt >= 3 || !deps.isDuplicateReservationError(error)) throw error
          // Another instance claimed the slot; re-read and try a different one.
        }
      }
    }

    const after = await deps.evaluateQuota(vendorId)
    if (!isWithinServiceLimit(after)) {
      await rollback(value)
      return { ok: false, reason: "quota", quota: after }
    }

    return { ok: true, value }
  })
}

import type { SubscriptionPlan } from "../types/subscription.js"
import { assertCanCreateActiveService } from "./subscriptions.service.js"

export interface ServiceQuota {
  allowed: boolean
  plan: SubscriptionPlan
  activeCount: number
  limit: number | null
}

/**
 * Serializes every quota-sensitive service change (create, reactivate, admin
 * approval) for the same vendor. One shared lock is essential: separate locks
 * per endpoint would still let a create race an approval.
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

/** Injected so the quota race can be tested without MongoDB. */
export interface QuotaGuardDeps {
  evaluateQuota(vendorId: string): Promise<ServiceQuota>
  withLock<T>(vendorId: string, work: () => Promise<T>): Promise<T>
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
}

/**
 * Runs an activation under the vendor lock, checking the quota before and
 * after the write. The second check plus rollback closes the stale-read window
 * that previously allowed concurrent calls to create a fourth active service.
 */
export async function withQuotaGuard<T>(
  vendorId: string,
  work: () => Promise<T>,
  rollback: (value: T) => Promise<void>,
  deps: QuotaGuardDeps = defaultDeps,
): Promise<QuotaGuardResult<T>> {
  return deps.withLock(vendorId, async () => {
    const before = await deps.evaluateQuota(vendorId)
    if (!before.allowed) return { ok: false, reason: "quota", quota: before }

    const value = await work()

    const after = await deps.evaluateQuota(vendorId)
    if (!isWithinServiceLimit(after)) {
      await rollback(value)
      return { ok: false, reason: "quota", quota: after }
    }

    return { ok: true, value }
  })
}

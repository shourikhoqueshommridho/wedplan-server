import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  SERVICE_QUOTA_INDEX,
  isQuotaDuplicateKeyError,
  prepareServiceSlot,
  type ActiveSlotDocument,
  type ServiceSlotDeps,
} from "../services/service-quota-db.service.js"
import {
  withQuotaGuard,
  type QuotaContext,
  type QuotaGuardDeps,
} from "../services/service-quota.service.js"

const VENDOR = "vendor-1"

interface FakeService {
  id: string
  vendorId: string
  isActive: boolean
  quotaSlot?: number
}

function duplicateError(): Error {
  return Object.assign(new Error("E11000 duplicate key"), {
    name: "MongoServerError",
    code: 11000,
  })
}

/** In-memory stand-in for the partial unique index on `quotaSlot`. */
class FakeServiceStore {
  readonly docs: FakeService[] = []
  private sequence = 0

  constructor(
    private readonly plan: "free" | "premium" = "free",
    private readonly activeCountOverride?: () => number,
  ) {}

  addLegacy(id: string, isActive = true): void {
    this.docs.push({ id, vendorId: VENDOR, isActive })
  }

  active(vendorId: string): number {
    return this.docs.filter((doc) => doc.vendorId === vendorId && doc.isActive).length
  }

  deactivate(id: string): void {
    const doc = this.docs.find((entry) => entry.id === id)
    if (!doc) return
    doc.isActive = false
    delete doc.quotaSlot
  }

  slotDeps(): ServiceSlotDeps {
    return {
      getPlan: async () => this.plan,
      findActive: async (vendorId): Promise<ActiveSlotDocument[]> =>
        this.docs
          .filter((doc) => doc.vendorId === vendorId && doc.isActive)
          .map((doc) => ({ _id: doc.id, ...(doc.quotaSlot !== undefined ? { quotaSlot: doc.quotaSlot } : {}) })),
      assignSlot: async (id, slot) => {
        const doc = this.docs.find((entry) => entry.id === String(id))
        if (!doc || doc.quotaSlot !== undefined) return false
        if (this.docs.some((entry) => entry !== doc && entry.vendorId === doc.vendorId && entry.quotaSlot === slot)) {
          throw duplicateError()
        }
        doc.quotaSlot = slot
        return true
      },
    }
  }

  guardDeps(): QuotaGuardDeps {
    return {
      evaluateQuota: async (vendorId) => {
        const activeCount = this.activeCountOverride?.() ?? this.active(vendorId)
        return {
          allowed: this.plan === "premium" || activeCount < 3,
          plan: this.plan,
          activeCount,
          limit: this.plan === "premium" ? null : 3,
        }
      },
      // No process-local lock: simulates independent backend instances.
      withLock: async (_vendorId, work) => work(),
      prepare: (vendorId) => prepareServiceSlot(vendorId, this.slotDeps()),
      isDuplicateReservationError: isQuotaDuplicateKeyError,
    }
  }

  async insert(vendorId: string, slot: number | null): Promise<string> {
    await Promise.resolve()
    if (slot !== null && this.docs.some((doc) => doc.vendorId === vendorId && doc.quotaSlot === slot)) {
      throw duplicateError()
    }
    this.sequence += 1
    const id = `service-${this.sequence}`
    this.docs.push({
      id,
      vendorId,
      isActive: true,
      ...(slot === null ? {} : { quotaSlot: slot }),
    })
    return id
  }

  async insertWithGuard(vendorId: string): Promise<boolean> {
    const result = await withQuotaGuard(
      vendorId,
      async ({ slot }: QuotaContext) => this.insert(vendorId, slot),
      async () => undefined,
      this.guardDeps(),
    )
    return result.ok
  }
}

describe("database-level service quota", () => {
  it("uses a unique partial index scoped to reserved slots", () => {
    assert.equal(SERVICE_QUOTA_INDEX.unique, true)
    assert.deepEqual(SERVICE_QUOTA_INDEX.key, { vendorId: 1, quotaSlot: 1 })
    assert.equal(SERVICE_QUOTA_INDEX.name, "services_vendor_quota_slot_unique")
    assert.deepEqual(SERVICE_QUOTA_INDEX.partialFilterExpression, {
      quotaSlot: { $type: "number" },
    })
    assert.equal(isQuotaDuplicateKeyError(duplicateError()), true)
    assert.equal(isQuotaDuplicateKeyError(new Error("network down")), false)
  })

  it("reconciles legacy active services by assigning their slots first", async () => {
    const store = new FakeServiceStore()
    store.addLegacy("legacy-1")
    store.addLegacy("legacy-2")

    const preparation = await prepareServiceSlot(VENDOR, store.slotDeps())
    assert.deepEqual(preparation, { slot: 3 })
    assert.equal(store.docs[0]?.quotaSlot, 1)
    assert.equal(store.docs[1]?.quotaSlot, 2)
  })

  it("denies activation when three legacy active services already exist", async () => {
    const store = new FakeServiceStore()
    store.addLegacy("legacy-1")
    store.addLegacy("legacy-2")
    store.addLegacy("legacy-3")

    assert.equal(await prepareServiceSlot(VENDOR, store.slotDeps()), null)
  })

  it("leaves premium vendors unlimited", async () => {
    const store = new FakeServiceStore("premium")
    assert.deepEqual(await prepareServiceSlot(VENDOR, store.slotDeps()), { slot: null })

    const results = await Promise.all(Array.from({ length: 8 }, () => store.insertWithGuard(VENDOR)))
    assert.equal(results.filter(Boolean).length, 8)
    assert.equal(store.docs.some((doc) => doc.quotaSlot !== undefined), false)
  })

  it("admits only three free services across concurrent instances", async () => {
    const store = new FakeServiceStore()

    const results = await Promise.all(Array.from({ length: 12 }, () => store.insertWithGuard(VENDOR)))

    assert.equal(results.filter(Boolean).length, 3)
    assert.equal(results.filter((ok) => !ok).length, 9)
    assert.equal(store.active(VENDOR), 3)
    assert.deepEqual(
      store.docs.map((doc) => doc.quotaSlot).sort(),
      [1, 2, 3],
    )
  })

  it("reuses a released slot after deactivation without exceeding the limit", async () => {
    const store = new FakeServiceStore()
    for (let index = 0; index < 3; index += 1) {
      assert.equal(await store.insertWithGuard(VENDOR), true)
    }

    const released = store.docs.find((doc) => doc.quotaSlot === 2)
    assert.ok(released)
    store.deactivate(released.id)

    assert.deepEqual(await prepareServiceSlot(VENDOR, store.slotDeps()), { slot: 2 })
    assert.equal(await store.insertWithGuard(VENDOR), true)
    assert.equal(store.active(VENDOR), 3)
    assert.equal(await store.insertWithGuard(VENDOR), false)
  })

  it("retries when another instance claims the candidate slot", async () => {
    const store = new FakeServiceStore()
    store.addLegacy("legacy-1")

    let attempts = 0
    const deps = store.slotDeps()
    const conflicting: ServiceSlotDeps = {
      ...deps,
      assignSlot: async (id, slot) => {
        attempts += 1
        if (attempts === 1 && slot === 2) throw duplicateError()
        return deps.assignSlot(id, slot)
      },
    }

    const preparation = await prepareServiceSlot(VENDOR, conflicting)
    const slot = preparation?.slot
    assert.notEqual(slot, null)
    assert.notEqual(slot, undefined)
    assert.equal(store.docs[0]?.quotaSlot !== undefined, true)
  })
})

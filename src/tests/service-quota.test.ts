import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { withApprovalLock } from "../services/service-approval.service.js"
import {
  withQuotaGuard,
  withServiceQuotaLock,
  type QuotaGuardDeps,
  type ServiceQuota,
} from "../services/service-quota.service.js"

const allowed: ServiceQuota = { allowed: true, plan: "free", activeCount: 2, limit: 3 }
const denied: ServiceQuota = { allowed: false, plan: "free", activeCount: 3, limit: 3 }
const overLimit: ServiceQuota = { allowed: false, plan: "free", activeCount: 4, limit: 3 }

describe("service quota lock", () => {
  it("serializes concurrent work for the same vendor", async () => {
    let active = 0
    let maxActive = 0

    const run = () =>
      withServiceQuotaLock("vendor-1", async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await Promise.resolve()
        active -= 1
      })

    await Promise.all([run(), run(), run(), run()])
    assert.equal(maxActive, 1)
  })

  it("shares one queue with admin approvals", async () => {
    let active = 0
    let maxActive = 0

    const work = async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await Promise.resolve()
      active -= 1
    }

    await Promise.all([
      withServiceQuotaLock("vendor-1", work),
      withApprovalLock("vendor-1", work),
      withQuotaGuard("vendor-1", work, async () => undefined, {
        evaluateQuota: async () => allowed,
        withLock: withServiceQuotaLock,
      }),
    ])

    assert.equal(maxActive, 1)
  })

  it("does not serialize different vendors", async () => {
    let active = 0
    let maxActive = 0

    const work = async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await Promise.resolve()
      active -= 1
    }

    await Promise.all([
      withServiceQuotaLock("vendor-1", work),
      withServiceQuotaLock("vendor-2", work),
    ])
    assert.equal(maxActive, 2)
  })
})

describe("quota guard", () => {
  it("allows a create below the limit", async () => {
    const rollbacks: string[] = []
    const guard = await withQuotaGuard(
      "vendor-1",
      async () => "service-1",
      async (value) => {
        rollbacks.push(value)
      },
      {
        evaluateQuota: async () => allowed,
        withLock: withServiceQuotaLock,
      },
    )

    assert.deepEqual(guard, { ok: true, value: "service-1" })
    assert.deepEqual(rollbacks, [])
  })

  it("blocks a create when the quota is already full", async () => {
    let workCalls = 0
    const guard = await withQuotaGuard(
      "vendor-1",
      async () => {
        workCalls += 1
        return "service-1"
      },
      async () => {
        assert.fail("no rollback without a write")
      },
      {
        evaluateQuota: async () => denied,
        withLock: withServiceQuotaLock,
      },
    )

    assert.deepEqual(guard, { ok: false, reason: "quota", quota: denied })
    assert.equal(workCalls, 0)
  })

  it("rolls back when a stale read let an extra service through", async () => {
    let evaluation = 0
    const rollbacks: string[] = []
    const guard = await withQuotaGuard(
      "vendor-1",
      async () => "service-4",
      async (value) => {
        rollbacks.push(value)
      },
      {
        evaluateQuota: async () => {
          evaluation += 1
          return evaluation === 1 ? allowed : overLimit
        },
        withLock: withServiceQuotaLock,
      },
    )

    assert.deepEqual(guard, { ok: false, reason: "quota", quota: overLimit })
    assert.deepEqual(rollbacks, ["service-4"])
  })

  it("admits only three active services across concurrent submissions", async () => {
    let activeCount = 2
    let created = 0
    let rollbacks = 0

    const deps: QuotaGuardDeps = {
      evaluateQuota: async () => ({
        allowed: activeCount < 3,
        plan: "free",
        activeCount,
        limit: 3,
      }),
      withLock: withServiceQuotaLock,
    }

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        withQuotaGuard(
          "vendor-1",
          async () => {
            activeCount += 1
            created += 1
            return `service-${index}`
          },
          async () => {
            activeCount -= 1
            rollbacks += 1
          },
          deps,
        ),
      ),
    )

    assert.equal(results.filter((result) => result.ok).length, 1)
    assert.equal(results.filter((result) => !result.ok).length, 9)
    assert.equal(created, 1)
    assert.equal(activeCount, 3)
    assert.equal(rollbacks, 0)
  })

  it("does not leave a fourth service behind if a lock-free race slips through", async () => {
    let evaluation = 0
    let activeCount = 2
    const rollbacks: string[] = []

    const deps: QuotaGuardDeps = {
      evaluateQuota: async () => {
        evaluation += 1
        // Both calls observe the pre-race count; both post-write checks see 4.
        return evaluation <= 2
          ? { allowed: true, plan: "free", activeCount: 2, limit: 3 }
          : { allowed: false, plan: "free", activeCount: activeCount, limit: 3 }
      },
      withLock: async (_vendorId, work) => work(),
    }

    const results = await Promise.all(
      ["service-a", "service-b"].map((value) =>
        withQuotaGuard(
          "vendor-1",
          async () => {
            activeCount += 1
            return value
          },
          async (rolledBack) => {
            activeCount -= 1
            rollbacks.push(rolledBack)
          },
          deps,
        ),
      ),
    )

    assert.equal(results.filter((result) => result.ok).length, 0)
    assert.deepEqual(rollbacks.sort(), ["service-a", "service-b"])
    assert.equal(activeCount, 2)
  })
})

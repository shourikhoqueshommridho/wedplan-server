import assert from "node:assert/strict"
import type { NextFunction, Request, Response } from "express"
import { describe, it } from "node:test"

import { makeRequireRole } from "../middleware/auth.js"
import {
  makeRequireActiveUser,
  type ActiveUserDeps,
  type BlockableUserDocument,
} from "../middleware/blocked.js"
import {
  deleteAdminService,
  listAdminTransactions,
  setUserBlocked,
  type AdminTransactionDeps,
  type AdminUserDeps,
} from "../services/admin.service.js"
import type { AuthContext } from "../types/auth.js"
import type { PaymentTransactionRecord } from "../types/subscription.js"

const ADMIN_ID = "admin-user-1"
const TARGET_ID = "vendor-user-1"

function authContext(role: "admin" | "vendor" | "customer"): AuthContext {
  return {
    user: {
      id: role === "admin" ? ADMIN_ID : TARGET_ID,
      name: "Test User",
      email: "test@example.test",
      emailVerified: true,
      image: null,
      role,
      createdAt: null,
    },
    session: { id: "session-1", expiresAt: null, createdAt: null },
  }
}

function mockResponse() {
  let status = 200
  let body: unknown = null
  const response = {
    status: (value: number) => {
      status = value
      return response
    },
    json: (value: unknown) => {
      body = value
      return response
    },
  } as unknown as Response
  return {
    response,
    result: () => ({ status, body }),
  }
}

describe("admin role authorization", () => {
  it("rejects non-admin roles for admin endpoints", async () => {
    for (const role of ["vendor", "customer"] as const) {
      const { response, result } = mockResponse()
      const request = { auth: authContext(role) } as unknown as Request
      let nextCalled = false

      await makeRequireRole(["admin"])(
        request,
        response,
        (() => {
          nextCalled = true
        }) as NextFunction,
      )

      assert.equal(nextCalled, false)
      assert.equal(result().status, 403)
    }
  })

  it("allows an admin through the role gate", async () => {
    const { response } = mockResponse()
    let nextCalled = false
    await makeRequireRole(["admin"])(
      { auth: authContext("admin") } as unknown as Request,
      response,
      (() => {
        nextCalled = true
      }) as NextFunction,
    )
    assert.equal(nextCalled, true)
  })
})

describe("admin user block/unblock", () => {
  function deps(existing = true) {
    const updates: Array<{
      id: string
      values: Record<string, unknown>
      unset?: string[]
    }> = []
    const resolved: AdminUserDeps = {
      findUser: async (id) => (existing && id === TARGET_ID ? { id, role: "vendor" } : null),
      updateUser: async (id, values, unset) => {
        updates.push({ id, values, unset })
        return existing
      },
    }
    return { resolved, updates }
  }

  it("blocks a user and persists the blocked flag", async () => {
    const { resolved, updates } = deps()
    const result = await setUserBlocked(TARGET_ID, true, ADMIN_ID, "Fraud", resolved)

    assert.deepEqual(result, { ok: true })
    assert.equal(updates[0]?.values.blocked, true)
    assert.equal(updates[0]?.values.blockedReason, "Fraud")
  })

  it("unblocks a user and clears blocked metadata", async () => {
    const { resolved, updates } = deps()
    const result = await setUserBlocked(TARGET_ID, false, ADMIN_ID, null, resolved)

    assert.deepEqual(result, { ok: true })
    assert.equal(updates[0]?.values.blocked, false)
    assert.deepEqual(updates[0]?.unset, ["blockedAt", "blockedReason"])
  })

  it("prevents an admin from blocking their own account", async () => {
    const { resolved, updates } = deps(false)
    const result = await setUserBlocked(ADMIN_ID, true, ADMIN_ID, null, resolved)

    assert.deepEqual(result, { ok: false, reason: "self" })
    assert.equal(updates.length, 0)
  })

  it("reports a missing user", async () => {
    const { resolved } = deps(false)
    const result = await setUserBlocked(TARGET_ID, true, ADMIN_ID, null, resolved)
    assert.deepEqual(result, { ok: false, reason: "not_found" })
  })
})

describe("blocked-user gate on protected routes", () => {
  function deps(blocked: boolean): ActiveUserDeps {
    const user: BlockableUserDocument = {
      _id: TARGET_ID,
      ...(blocked ? { blocked: true } : {}),
    }
    return { findUser: async () => user }
  }

  it("returns 403 for a blocked user", async () => {
    const { response, result } = mockResponse()
    let nextCalled = false
    const request = { auth: authContext("vendor") } as unknown as Request

    await makeRequireActiveUser(deps(true))(
      request,
      response,
      (() => {
        nextCalled = true
      }) as NextFunction,
    )

    assert.equal(nextCalled, false)
    assert.equal(result().status, 403)
  })

  it("continues for an active user", async () => {
    const { response } = mockResponse()
    let nextCalled = false
    const request = { auth: authContext("vendor") } as unknown as Request

    await makeRequireActiveUser(deps(false))(
      request,
      response,
      (() => {
        nextCalled = true
      }) as NextFunction,
    )

    assert.equal(nextCalled, true)
  })
})

describe("admin service deletion", () => {
  it("deletes an existing service", async () => {
    const result = await deleteAdminService("service-1", {
      deleteService: async () => true,
    })
    assert.deepEqual(result, { ok: true })
  })

  it("reports a missing service id safely", async () => {
    const result = await deleteAdminService("service-1", {
      deleteService: async () => false,
    })
    assert.deepEqual(result, { ok: false, reason: "not_found" })
  })
})

describe("admin transactions", () => {
  const record = (id: string): PaymentTransactionRecord => ({
    _id: undefined,
    vendorId: TARGET_ID,
    plan: "premium",
    amount: 20,
    currency: "USD",
    stripeSessionId: `cs_${id}`,
    stripeSubscriptionId: `sub_${id}`,
    status: "paid",
    stripeEventId: `evt_${id}`,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  })

  it("maps real records with vendor names", async () => {
    const deps: AdminTransactionDeps = {
      findTransactions: async () => [record("1")],
      findVendors: async () => [{ id: TARGET_ID, name: "Test Vendor" }],
    }
    const transactions = await listAdminTransactions(100, deps)

    assert.equal(transactions.length, 1)
    assert.equal(transactions[0]?.vendorId, TARGET_ID)
    assert.equal(transactions[0]?.vendorName, "Test Vendor")
    assert.equal(transactions[0]?.plan, "premium")
    assert.equal(transactions[0]?.amount, 20)
    assert.equal(transactions[0]?.status, "paid")
    assert.equal(transactions[0]?.createdAt, "2026-01-01T00:00:00.000Z")
  })

  it("does not invent vendor names or transactions", async () => {
    const deps: AdminTransactionDeps = {
      findTransactions: async () => [],
      findVendors: async () => [],
    }
    assert.deepEqual(await listAdminTransactions(100, deps), [])
  })
})

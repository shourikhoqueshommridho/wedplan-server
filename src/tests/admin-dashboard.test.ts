import assert from "node:assert/strict"
import type { NextFunction, Request, Response } from "express"
import type { Filter } from "mongodb"
import { describe, it } from "node:test"

import { makeRequireRole } from "../middleware/auth.js"
import {
  SUCCESSFUL_TRANSACTION_STATUSES,
  getAdminOverview,
  type AdminOverviewDeps,
} from "../services/admin-overview.service.js"
import {
  adminUsersFilter,
  getAdminUserById,
  listAdminUsers,
  type AdminUserDocument,
  type AdminUserListDeps,
  type AdminUsersQuery,
} from "../services/admin.service.js"
import type { AuthContext } from "../types/auth.js"
import { objectIdSchema } from "../validators/vendor.js"

const USER_ID = "6b00b69c0b2748f5b8e3858a"

function authContext(role: "admin" | "vendor" | "customer"): AuthContext {
  return {
    user: {
      id: role === "admin" ? USER_ID : "6b00b7070b2748f5b8e3858d",
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
  const response = {
    status: (value: number) => {
      status = value
      return response
    },
    json: () => response,
  } as unknown as Response
  return { response, status: () => status }
}

const baseQuery: AdminUsersQuery = {
  search: "",
  role: "all",
  status: "all",
  page: 1,
  pageSize: 8,
}

function listDeps(overrides: Partial<AdminUserListDeps> = {}) {
  const calls: { filter: Filter<AdminUserDocument>; skip: number; limit: number }[] = []
  const document: AdminUserDocument = {
    _id: USER_ID,
    name: "Test User",
    email: "test@example.test",
    role: "customer",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    emailVerified: true,
  }

  const deps: AdminUserListDeps = {
    countUsers: async () => 1,
    findUsers: async (filter, skip, limit) => {
      calls.push({ filter, skip, limit })
      return [document]
    },
    findUser: async () => document,
    ...overrides,
  }
  return { deps, calls, document }
}

describe("admin endpoint authorization", () => {
  it("allows admins and rejects customers/vendors", async () => {
    for (const role of ["vendor", "customer"] as const) {
      const { response, status } = mockResponse()
      let nextCalled = false
      await makeRequireRole(["admin"])(
        { auth: authContext(role) } as unknown as Request,
        response,
        (() => {
          nextCalled = true
        }) as NextFunction,
      )
      assert.equal(nextCalled, false)
      assert.equal(status(), 403)
    }

    let passed = false
    await makeRequireRole(["admin"])(
      { auth: authContext("admin") } as unknown as Request,
      mockResponse().response,
      (() => {
        passed = true
      }) as NextFunction,
    )
    assert.equal(passed, true)
  })
})

describe("server-side user search, filters and pagination", () => {
  it("escapes search text before matching name and email", () => {
    const filter = adminUsersFilter({ ...baseQuery, search: "a+b(c)" })
    const json = JSON.stringify(filter)

    assert.match(json, /\\\+/)
    assert.match(json, /\\\(/)
    assert.match(json, /name/)
    assert.match(json, /email/)
    assert.doesNotMatch(json, /\$regex":"a\+b\(c\)/)
  })

  it("filters by role, including legacy users without a role", () => {
    const vendor = adminUsersFilter({ ...baseQuery, role: "vendor" })
    const customer = adminUsersFilter({ ...baseQuery, role: "customer" })

    assert.deepEqual(vendor, { $and: [{ role: "vendor" }] })
    assert.deepEqual(customer, { $and: [{ role: { $nin: ["admin", "vendor"] } }] })
  })

  it("filters by blocked and active status using shared block flags", () => {
    const blocked = adminUsersFilter({ ...baseQuery, status: "blocked" })
    const active = adminUsersFilter({ ...baseQuery, status: "active" })
    const blockedJson = JSON.stringify(blocked)
    const activeJson = JSON.stringify(active)

    assert.match(blockedJson, /blocked/)
    assert.match(blockedJson, /banned/)
    assert.match(activeJson, /\$nor/)
  })

  it("returns correct page metadata and database skip/limit", async () => {
    const { deps, calls } = listDeps({
      countUsers: async () => 25,
      findUsers: async (_filter, skip, limit) => {
        calls.push({ filter: {}, skip, limit })
        return []
      },
    })

    const result = await listAdminUsers({ ...baseQuery, page: 2, pageSize: 8 }, deps)

    assert.deepEqual(result.meta, { page: 2, pageSize: 8, total: 25, totalPages: 4 })
    assert.deepEqual(calls[0], { filter: {}, skip: 8, limit: 8 })
  })

  it("clamps out-of-range pages to the last page", async () => {
    const { deps, calls } = listDeps({
      countUsers: async () => 9,
      findUsers: async (_filter, skip, limit) => {
        calls.push({ filter: {}, skip, limit })
        return []
      },
    })

    const result = await listAdminUsers({ ...baseQuery, page: 99 }, deps)
    assert.equal(result.meta.page, 2)
    assert.equal(calls[0]?.skip, 8)
  })

  it("rejects malformed pagination and filter inputs", () => {
    assert.equal(objectIdSchema.safeParse("not-an-id").success, false)
  })
})

describe("admin user details", () => {
  it("maps only allow-listed fields and never exposes secrets", async () => {
    const unsafe = {
      _id: USER_ID,
      name: "Test User",
      email: "test@example.test",
      image: null,
      role: "customer",
      emailVerified: true,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      password: "super-secret-hash",
      hash: "internal-hash",
      salt: "internal-salt",
      stripeCustomerId: "cus_secret",
      blocked: true,
      blockedAt: new Date("2026-02-01T00:00:00.000Z"),
      blockedReason: "Fraud",
    } as AdminUserDocument

    const user = await getAdminUserById(USER_ID, { ...listDeps().deps, findUser: async () => unsafe })
    assert.ok(user)
    assert.deepEqual(Object.keys(user).sort(), [
      "blocked",
      "blockedAt",
      "blockedReason",
      "createdAt",
      "email",
      "emailVerified",
      "id",
      "image",
      "name",
      "role",
    ])
    assert.equal(user.blocked, true)
    assert.equal(user.blockedReason, "Fraud")
    assert.equal(JSON.stringify(user).includes("super-secret-hash"), false)
    assert.equal(JSON.stringify(user).includes("cus_secret"), false)
  })

  it("reports a missing user", async () => {
    const user = await getAdminUserById(USER_ID, {
      ...listDeps().deps,
      findUser: async () => null,
    })
    assert.equal(user, null)
  })

  it("uses the shared block flags for the displayed status", () => {
    const { deps } = listDeps({
      findUser: async () => ({ ...listDeps().document, banned: true }),
    })
    return getAdminUserById(USER_ID, deps).then((user) => {
      assert.equal(user?.blocked, true)
    })
  })
})

describe("admin overview statistics", () => {
  function overviewDeps(overrides: Partial<AdminOverviewDeps> = {}) {
    const transactionFilters: Filter<Document>[] = []
    const deps: AdminOverviewDeps = {
      countUsers: async () => 10,
      countServices: async () => 6,
      countBookings: async () => 5,
      countTransactions: async (filter) => {
        transactionFilters.push(filter)
        return 4
      },
      aggregateRevenue: async () => [{ _id: "USD", amount: 60 }],
      ...overrides,
    }
    return { deps, transactionFilters }
  }

  it("returns real counts from database queries", async () => {
    const { deps } = overviewDeps()
    const overview = await getAdminOverview(deps)

    assert.deepEqual(overview, {
      totalUsers: 10,
      totalCustomers: 10,
      totalVendors: 10,
      blockedUsers: 10,
      totalServices: 6,
      pendingServices: 6,
      approvedActiveServices: 6,
      totalBookings: 5,
      pendingBookings: 5,
      completedBookings: 5,
      totalTransactions: 4,
      successfulTransactions: 4,
      revenueByCurrency: [{ currency: "USD", amount: 60 }],
    })
  })

  it("counts revenue only from paid transactions", async () => {
    const { deps, transactionFilters } = overviewDeps()
    await getAdminOverview(deps)

    assert.deepEqual(SUCCESSFUL_TRANSACTION_STATUSES, ["paid"])
    assert.deepEqual(transactionFilters[1], { status: { $in: ["paid"] } })
    assert.deepEqual(JSON.stringify(transactionFilters[1]).includes("failed"), false)
    assert.equal(JSON.stringify(transactionFilters[1]).includes("refunded"), false)
    assert.equal(JSON.stringify(transactionFilters[1]).includes("pending"), false)
    assert.equal(JSON.stringify(transactionFilters[1]).includes("cancelled"), false)
  })

  it("returns valid empty statistics for an empty transaction collection", async () => {
    const { deps } = overviewDeps({
      countUsers: async () => 0,
      countServices: async () => 0,
      countBookings: async () => 0,
      countTransactions: async () => 0,
      aggregateRevenue: async () => [],
    })
    const overview = await getAdminOverview(deps)

    assert.equal(overview.totalUsers, 0)
    assert.equal(overview.totalTransactions, 0)
    assert.equal(overview.successfulTransactions, 0)
    assert.deepEqual(overview.revenueByCurrency, [])
  })
})

import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { NextFunction, Request, Response } from "express"

import { makeGetServiceById } from "../controllers/services.controller.js"
import { idFilter, isObjectId } from "../lib/object-id.js"
import { escapeRegExp } from "../lib/regex.js"
import {
  createBookingRequest,
  type BookableService,
  type BookingCustomer,
  type BookingRequestDeps,
} from "../services/booking-request.service.js"
import { evaluateBookingTransition } from "../services/booking-transitions.js"
import {
  blockedVendorFilter,
  isVendorBlocked,
  listBlockedVendorIds,
  type BlockedVendorCandidate,
} from "../services/blocked-vendors.service.js"
import { bookingIdFilter } from "../services/bookings.service.js"
import { publicServiceFilter } from "../services/services.service.js"
import type { BookingStatus } from "../types/booking.js"
import type { CreateBookingInput } from "../validators/booking.js"
import { objectIdSchema } from "../validators/vendor.js"

const CUSTOMER_ID = "65b1b2c3d4e5f60718293a4c"
const OTHER_CUSTOMER_ID = "65c1b2c3d4e5f60718293a4d"
const VENDOR_ID = "65d1b2c3d4e5f60718293a4e"
const OTHER_VENDOR_ID = "65e1b2c3d4e5f60718293a4f"
const SERVICE_ID = "65a1b2c3d4e5f60718293a4b"
const NO_SUCH_ID = "65f1b2c3d4e5f60718293a40"

const service: BookableService = {
  id: SERVICE_ID,
  name: "Wedding Decoration",
  vendor: { id: VENDOR_ID, name: "Vendor Studio" },
  image: { src: "https://i.ibb.co/abc123/decor.jpg" },
  price: { amount: 25000 },
}

const customer: BookingCustomer = {
  id: CUSTOMER_ID,
  name: "Test Customer",
  email: "customer@example.test",
}

const input: CreateBookingInput = {
  serviceId: SERVICE_ID,
  eventDate: "2027-06-15",
  eventLocation: "Dhaka, Bangladesh",
  message: "",
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
  return { response, result: () => ({ status, body }) }
}

describe("booking cancellation and status state machine", () => {
  const booking = (status: BookingStatus) => ({
    customerId: CUSTOMER_ID,
    vendorId: VENDOR_ID,
    status,
  })

  it("lets a customer cancel their own pending booking", () => {
    const decision = evaluateBookingTransition(
      booking("pending"),
      { role: "customer", id: CUSTOMER_ID },
      "cancelled",
    )
    assert.deepEqual(decision, { allowed: true })
  })

  it("rejects cancellation of an accepted booking with 409", () => {
    const decision = evaluateBookingTransition(
      booking("accepted"),
      { role: "customer", id: CUSTOMER_ID },
      "cancelled",
    )
    assert.equal(decision.allowed, false)
    if (decision.allowed) return
    assert.equal(decision.status, 409)
    assert.match(decision.message, /can no longer be cancelled/)
  })

  it("rejects cancellation of declined, cancelled and completed bookings with 409", () => {
    for (const status of ["declined", "cancelled", "completed"] as const) {
      const decision = evaluateBookingTransition(
        booking(status),
        { role: "customer", id: CUSTOMER_ID },
        "cancelled",
      )
      assert.equal(decision.allowed, false)
      if (decision.allowed) continue
      assert.equal(decision.status, 409)
    }
  })

  it("rejects cancelling another customer's booking with 403", () => {
    const decision = evaluateBookingTransition(
      booking("pending"),
      { role: "customer", id: OTHER_CUSTOMER_ID },
      "cancelled",
    )
    assert.equal(decision.allowed, false)
    if (decision.allowed) return
    assert.equal(decision.status, 403)
  })

  it("rejects a customer trying to accept, decline or complete", () => {
    for (const next of ["accepted", "declined", "completed"] as const) {
      const decision = evaluateBookingTransition(
        booking("pending"),
        { role: "customer", id: CUSTOMER_ID },
        next,
      )
      assert.equal(decision.allowed, false)
      if (decision.allowed) continue
      assert.equal(decision.status, 403)
    }
  })

  it("keeps valid vendor transitions and rejects invalid ones", () => {
    const vendor = { role: "vendor" as const, id: VENDOR_ID }
    assert.deepEqual(evaluateBookingTransition(booking("pending"), vendor, "accepted"), {
      allowed: true,
    })
    assert.deepEqual(evaluateBookingTransition(booking("pending"), vendor, "declined"), {
      allowed: true,
    })
    assert.deepEqual(evaluateBookingTransition(booking("accepted"), vendor, "completed"), {
      allowed: true,
    })

    for (const [current, next] of [
      ["pending", "completed"],
      ["accepted", "declined"],
      ["declined", "accepted"],
      ["cancelled", "accepted"],
      ["completed", "accepted"],
    ] as const) {
      const decision = evaluateBookingTransition(booking(current), vendor, next)
      assert.equal(decision.allowed, false)
      if (decision.allowed) continue
      assert.equal(decision.status, 409)
    }

    const foreign = evaluateBookingTransition(
      booking("pending"),
      { role: "vendor", id: OTHER_VENDOR_ID },
      "accepted",
    )
    assert.equal(foreign.allowed, false)
    if (!foreign.allowed) assert.equal(foreign.status, 403)
  })

  it("does not let admins or unknown roles change booking statuses", () => {
    for (const role of ["admin"] as const) {
      for (const next of ["accepted", "declined", "completed", "cancelled"] as const) {
        const decision = evaluateBookingTransition(
          booking("pending"),
          { role, id: "admin-user" },
          next,
        )
        assert.equal(decision.allowed, false)
        if (decision.allowed) continue
        assert.equal(decision.status, 403)
      }
    }
  })
})

describe("blocked vendor protection", () => {
  const candidate = (id: string): BlockedVendorCandidate => ({ _id: id })

  const deps = {
    findBlockedUsers: async () => [
      { ...candidate("blocked-1"), blocked: true },
      { ...candidate("blocked-2"), isBlocked: true },
      { ...candidate("blocked-3"), banned: true },
      { ...candidate("blocked-4"), suspended: true },
      { ...candidate("blocked-5"), status: "blocked" },
      { ...candidate("blocked-6"), status: "banned" },
      { ...candidate("blocked-7"), accountStatus: "blocked" },
      { ...candidate("active-1"), status: "active" },
    ],
  }

  it("collects only users the existing block rules consider blocked", async () => {
    assert.deepEqual(await listBlockedVendorIds(deps), [
      "blocked-1",
      "blocked-2",
      "blocked-3",
      "blocked-4",
      "blocked-5",
      "blocked-6",
      "blocked-7",
    ])
  })

  it("adds a vendorId exclusion only when vendors are blocked", () => {
    assert.deepEqual(blockedVendorFilter([]), {})
    assert.deepEqual(blockedVendorFilter(["blocked-1"]), {
      vendorId: { $nin: ["blocked-1"] },
    })
  })

  it("composes the public filter with the blocked-vendor exclusion", () => {
    assert.deepEqual(publicServiceFilter([]), { status: "approved", isActive: true })
    assert.deepEqual(publicServiceFilter(["blocked-1"]), {
      status: "approved",
      isActive: true,
      vendorId: { $nin: ["blocked-1"] },
    })
  })

  it("detects a blocked vendor by id", async () => {
    assert.equal(await isVendorBlocked("blocked-1", deps), true)
    assert.equal(await isVendorBlocked("active-1", deps), false)
  })

  it("rejects a booking for a blocked vendor before writing", async () => {
    let inserts = 0
    const bookingDeps: BookingRequestDeps = {
      findService: async () => service,
      isVendorBlocked: async (vendorId) => vendorId === VENDOR_ID,
      insert: async () => {
        inserts += 1
        throw new Error("must not insert")
      },
    }

    const result = await createBookingRequest(input, customer, bookingDeps)
    assert.deepEqual(result, { ok: false, reason: "vendor_blocked" })
    assert.equal(inserts, 0)
  })
})

describe("vendor search regex safety", () => {
  it("escapes regex metacharacters into literal matches", () => {
    const search = "a+b(c)[d].*?"
    const pattern = new RegExp(`^${escapeRegExp(search)}$`, "i")

    assert.equal(pattern.test("A+B(C)[D].*?"), true)
    assert.equal(pattern.test("aaabccdx"), false)
    assert.equal(pattern.test("abc"), false)
  })

  it("neutralizes catastrophic-backtracking input", () => {
    const pattern = new RegExp(escapeRegExp("(a+)+$"))
    assert.equal(pattern.test("a".repeat(500) + "!"), false)
    assert.equal(pattern.test("(a+)+$"), true)
  })
})

describe("malformed ObjectId handling", () => {
  it("recognizes valid hex ids and rejects malformed ones", () => {
    assert.equal(isObjectId(SERVICE_ID), true)
    assert.equal(isObjectId("not-an-object-id"), false)
    assert.equal(objectIdSchema.safeParse(SERVICE_ID).success, true)
    assert.equal(objectIdSchema.safeParse("bad(id)").success, false)
  })

  it("builds a string-only filter for malformed ids without throwing", () => {
    assert.deepEqual(idFilter("bad(id)"), { _id: "bad(id)" })
    assert.deepEqual(bookingIdFilter("broken"), { _id: "broken" })

    const valid = idFilter(SERVICE_ID) as { $or: unknown[] }
    assert.equal(Array.isArray(valid.$or), true)
    assert.equal(valid.$or.length, 2)
  })

  it("returns 400 for malformed ids and 404 for valid nonexistent ids", async () => {
    const calls: string[] = []
    const handler = makeGetServiceById({
      findService: async (id) => {
        calls.push(id)
        return null
      },
    })

    const malformed = mockResponse()
    await handler(
      { params: { id: "bad(id)" } } as unknown as Request,
      malformed.response,
      (() => {
        assert.fail("next must not be called")
      }) as NextFunction,
    )
    assert.equal(malformed.result().status, 400)
    assert.deepEqual(calls, [])

    const missing = mockResponse()
    await handler(
      { params: { id: NO_SUCH_ID } } as unknown as Request,
      missing.response,
      (() => {
        assert.fail("next must not be called")
      }) as NextFunction,
    )
    assert.equal(missing.result().status, 404)
    assert.deepEqual(calls, [NO_SUCH_ID])
  })
})

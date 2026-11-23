import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  createBookingRequest,
  type BookableService,
  type BookingCustomer,
  type BookingRequestDeps,
} from "../services/booking-request.service.js"
import {
  ACTIVE_BOOKING_INDEX,
  DuplicateActiveBookingError,
  activeBookingKey,
  isActiveBookingStatus,
  statusUpdateFor,
} from "../services/bookings.service.js"
import type { Booking, BookingRecord } from "../types/booking.js"
import type { CreateBookingInput } from "../validators/booking.js"

const SERVICE_ID = "65a1b2c3d4e5f60718293a4b"
const CUSTOMER_ID = "65b1b2c3d4e5f60718293a4c"
const OTHER_CUSTOMER_ID = "65c1b2c3d4e5f60718293a4d"
const VENDOR_ID = "65d1b2c3d4e5f60718293a4e"
const EVENT_DATE = "2027-06-15"
const NOW = new Date("2026-11-23T00:00:00.000Z")

const input: CreateBookingInput = {
  serviceId: SERVICE_ID,
  eventDate: EVENT_DATE,
  eventLocation: "Dhaka, Bangladesh",
  message: "Please decorate the venue.",
}

const service: BookableService = {
  id: SERVICE_ID,
  name: "Wedding Decoration",
  vendor: { id: VENDOR_ID, name: "Vendor Studio" },
  image: { src: "https://images.example.test/decor.jpg" },
  price: { amount: 25000 },
}

const customer: BookingCustomer = {
  id: CUSTOMER_ID,
  name: "Test Customer",
  email: "customer@example.test",
}

function toBooking(record: BookingRecord, id: string): Booking {
  return {
    id,
    customerId: record.customerId,
    customerName: record.customerName,
    customerEmail: record.customerEmail,
    vendorId: record.vendorId,
    vendorName: record.vendorName,
    serviceId: record.serviceId,
    serviceName: record.serviceName,
    serviceImage: record.serviceImage,
    price: record.price,
    eventDate: record.eventDate,
    eventLocation: record.eventLocation,
    message: record.message,
    status: record.status,
    paymentStatus: record.paymentStatus,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  }
}

/**
 * In-memory stand-in for the unique sparse index. The key check and store are
 * synchronous so concurrent inserts observe the same atomicity as MongoDB.
 */
class UniqueBookingStore {
  private sequence = 0
  private readonly records: BookingRecord[] = []

  async insert(record: BookingRecord): Promise<Booking> {
    await Promise.resolve()
    const key = activeBookingKey(record.customerId, record.serviceId, record.eventDate)
    if (
      this.records.some(
        (stored) =>
          stored.activeBookingKey === key && isActiveBookingStatus(stored.status),
      )
    ) {
      throw new DuplicateActiveBookingError()
    }

    const stored: BookingRecord = { ...record, activeBookingKey: key }
    this.records.push(stored)
    this.sequence += 1
    return toBooking(stored, `booking-${this.sequence}`)
  }

  deactivateActive(booking: Booking, status: "cancelled" | "declined" | "completed"): void {
    const record = this.records.find((_, index) => `booking-${index + 1}` === booking.id)
    if (!record) return
    const update = statusUpdateFor(status, NOW)
    record.status = status
    if (update.$unset) delete record.activeBookingKey
  }

  count(): number {
    return this.records.length
  }
}

function depsFor(store: UniqueBookingStore): BookingRequestDeps {
  return {
    findService: async (serviceId) => ({ ...service, id: serviceId }),
    insert: (record) => store.insert(record),
  }
}

describe("booking reservation rules", () => {
  it("uses a unique sparse index so inactive bookings never block new requests", () => {
    assert.equal(ACTIVE_BOOKING_INDEX.unique, true)
    assert.equal(ACTIVE_BOOKING_INDEX.sparse, true)
    assert.deepEqual(ACTIVE_BOOKING_INDEX.key, { activeBookingKey: 1 })

    assert.equal(isActiveBookingStatus("pending"), true)
    assert.equal(isActiveBookingStatus("accepted"), true)
    assert.equal(isActiveBookingStatus("declined"), false)
    assert.equal(isActiveBookingStatus("cancelled"), false)
    assert.equal(isActiveBookingStatus("completed"), false)
  })

  it("releases the reservation when a request is rejected, cancelled or completed", () => {
    for (const status of ["declined", "cancelled", "completed"] as const) {
      const update = statusUpdateFor(status, NOW)
      assert.deepEqual(update.$set, { status, updatedAt: NOW })
      assert.deepEqual(update.$unset, { activeBookingKey: "" })
    }

    for (const status of ["pending", "accepted"] as const) {
      const update = statusUpdateFor(status, NOW)
      assert.equal(update.$unset, undefined)
    }
  })

  it("encodes the key without delimiter collisions", () => {
    assert.equal(
      activeBookingKey(CUSTOMER_ID, SERVICE_ID, EVENT_DATE),
      JSON.stringify([CUSTOMER_ID, SERVICE_ID, EVENT_DATE]),
    )
  })
})

describe("creating a booking request", () => {
  it("creates a normal request and snapshots the service", async () => {
    const store = new UniqueBookingStore()
    const result = await createBookingRequest(input, customer, depsFor(store), NOW)

    assert.equal(result.ok, true)
    if (!result.ok) return

    assert.equal(result.booking.status, "pending")
    assert.equal(result.booking.customerId, CUSTOMER_ID)
    assert.equal(result.booking.vendorId, VENDOR_ID)
    assert.equal(result.booking.serviceId, SERVICE_ID)
    assert.equal(result.booking.eventDate, EVENT_DATE)
    assert.equal(result.booking.price, 25000)
    assert.equal(store.count(), 1)
  })

  it("rejects a vendor booking their own service before writing", async () => {
    let inserts = 0
    const deps: BookingRequestDeps = {
      findService: async () => service,
      insert: async () => {
        inserts += 1
        throw new Error("must not insert")
      },
    }

    const result = await createBookingRequest(
      input,
      { ...customer, id: VENDOR_ID },
      deps,
      NOW,
    )

    assert.deepEqual(result, { ok: false, reason: "self_booking" })
    assert.equal(inserts, 0)
  })

  it("reports an unavailable service without writing", async () => {
    let inserts = 0
    const deps: BookingRequestDeps = {
      findService: async () => null,
      insert: async () => {
        inserts += 1
        throw new Error("must not insert")
      },
    }

    assert.deepEqual(await createBookingRequest(input, customer, deps, NOW), {
      ok: false,
      reason: "service_not_found",
    })
    assert.equal(inserts, 0)
  })

  it("rejects a duplicate active request from the unique index", async () => {
    const store = new UniqueBookingStore()
    const deps = depsFor(store)

    assert.equal((await createBookingRequest(input, customer, deps, NOW)).ok, true)
    const duplicate = await createBookingRequest(input, customer, deps, NOW)

    assert.deepEqual(duplicate, { ok: false, reason: "duplicate" })
    assert.equal(store.count(), 1)
  })

  it("rejects a duplicate legacy record that predates the unique key", async () => {
    const deps: BookingRequestDeps = {
      findService: async () => service,
      insert: async () => {
        throw new DuplicateActiveBookingError()
      },
    }

    assert.deepEqual(await createBookingRequest(input, customer, deps, NOW), {
      ok: false,
      reason: "duplicate",
    })
  })

  it("allows a different customer, service or date to book independently", async () => {
    const store = new UniqueBookingStore()
    const deps = depsFor(store)

    assert.equal((await createBookingRequest(input, customer, deps, NOW)).ok, true)
    assert.equal(
      (await createBookingRequest(input, { ...customer, id: OTHER_CUSTOMER_ID }, deps, NOW)).ok,
      true,
    )
    assert.equal(
      (await createBookingRequest({ ...input, serviceId: "65e1b2c3d4e5f60718293a4f" }, customer, deps, NOW))
        .ok,
      true,
    )
    assert.equal(
      (await createBookingRequest({ ...input, eventDate: "2027-06-16" }, customer, deps, NOW)).ok,
      true,
    )
    assert.equal(store.count(), 4)
  })

  it("allows rebooking after the previous request is rejected or cancelled", async () => {
    const store = new UniqueBookingStore()
    const deps = depsFor(store)
    const first = await createBookingRequest(input, customer, deps, NOW)
    assert.equal(first.ok, true)
    if (!first.ok) return

    store.deactivateActive(first.booking, "cancelled")
    const again = await createBookingRequest(input, customer, deps, NOW)
    assert.equal(again.ok, true)
    assert.equal(store.count(), 2)
  })

  it("admits exactly one winner across concurrent duplicate requests", async () => {
    const store = new UniqueBookingStore()
    const deps = depsFor(store)

    const results = await Promise.all(
      Array.from({ length: 12 }, () => createBookingRequest(input, customer, deps, NOW)),
    )

    assert.equal(results.filter((result) => result.ok).length, 1)
    assert.equal(
      results.filter((result) => !result.ok && result.reason === "duplicate").length,
      11,
    )
    assert.equal(store.count(), 1)
  })
})

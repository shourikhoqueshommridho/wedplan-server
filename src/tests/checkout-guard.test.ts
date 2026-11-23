import assert from "node:assert/strict"
import type { Collection } from "mongodb"
import { describe, it } from "node:test"

import {
  claimCheckoutReservation,
  checkoutClaimFilter,
} from "../services/checkout-guard.service.js"
import type { SubscriptionRecord } from "../types/subscription.js"

const VENDOR = "vendor-1"
const REQUEST_ID = "request-1"

interface RecordedCall {
  filter: unknown
  update: {
    $set: Record<string, unknown>
    $setOnInsert: Record<string, unknown>
  }
  options: { upsert?: boolean; returnDocument?: string }
}

function duplicateError(): Error {
  return Object.assign(new Error("E11000 duplicate key"), {
    name: "MongoServerError",
    code: 11000,
  })
}

/** Simulates the unique vendor index and the post-image return of findOneAndUpdate. */
class FakeSubscriptionCollection {
  readonly docs: Array<Record<string, unknown>> = []
  readonly calls: RecordedCall[] = []

  constructor(private readonly now: Date = new Date()) {}

  async findOneAndUpdate(
    filter: unknown,
    update: unknown,
    options: unknown,
  ): Promise<Record<string, unknown> | null> {
    const typedFilter = filter as { vendorId?: string }
    const typedUpdate = update as RecordedCall["update"]
    this.calls.push({
      filter,
      update: typedUpdate,
      options: options as RecordedCall["options"],
    })

    const vendorId = typedFilter.vendorId ?? ""
    const existing = this.docs.find((doc) => doc.vendorId === vendorId)

    if (existing) {
      const expiresAt = existing.checkoutReservationExpiresAt
      const hasLiveReservation =
        expiresAt instanceof Date && expiresAt.getTime() > this.now.getTime()
      const entitled =
        existing.plan === "premium" &&
        (existing.status === "active" || existing.status === "trialing")

      // A non-matching filter combined with upsert collides on vendorId.
      if (hasLiveReservation || entitled) throw duplicateError()

      Object.assign(existing, typedUpdate.$set)
      return { ...existing }
    }

    const inserted = { ...typedUpdate.$setOnInsert, ...typedUpdate.$set }
    this.docs.push(inserted)
    return { ...inserted }
  }

  asCollection(): Collection<SubscriptionRecord> {
    return this as unknown as Collection<SubscriptionRecord>
  }
}

describe("checkout reservation claim", () => {
  const now = new Date("2026-11-23T12:00:00.000Z")
  const expiresAt = new Date("2026-11-23T12:10:00.000Z")

  it("succeeds on a fresh upsert with a post-image return", async () => {
    const collection = new FakeSubscriptionCollection(now)

    const claimed = await claimCheckoutReservation(
      collection.asCollection(),
      VENDOR,
      REQUEST_ID,
      expiresAt,
      now,
    )

    assert.equal(claimed, true)
    assert.deepEqual(collection.calls[0]?.options, { upsert: true, returnDocument: "after" })
    assert.equal(collection.docs.length, 1)
    assert.equal(collection.docs[0]?.checkoutRequestId, REQUEST_ID)
    assert.equal(collection.docs[0]?.plan, "free")
    assert.equal(collection.docs[0]?.status, "incomplete")
  })

  it("succeeds on an existing eligible document", async () => {
    const collection = new FakeSubscriptionCollection(now)
    collection.docs.push({
      vendorId: VENDOR,
      plan: "free",
      status: "incomplete",
      createdAt: new Date("2026-11-23T11:00:00.000Z"),
    })

    const claimed = await claimCheckoutReservation(
      collection.asCollection(),
      VENDOR,
      REQUEST_ID,
      expiresAt,
      now,
    )

    assert.equal(claimed, true)
    assert.equal(collection.docs[0]?.checkoutRequestId, REQUEST_ID)
    assert.equal(
      (collection.docs[0]?.checkoutReservationExpiresAt as Date).toISOString(),
      expiresAt.toISOString(),
    )
  })

  it("rejects another live reservation without changing it", async () => {
    const collection = new FakeSubscriptionCollection(now)
    collection.docs.push({
      vendorId: VENDOR,
      plan: "free",
      status: "incomplete",
      checkoutRequestId: "other-inflight-request",
      checkoutReservationExpiresAt: new Date("2026-11-23T12:09:00.000Z"),
    })

    const claimed = await claimCheckoutReservation(
      collection.asCollection(),
      VENDOR,
      REQUEST_ID,
      expiresAt,
      now,
    )

    assert.equal(claimed, false)
    assert.equal(collection.docs[0]?.checkoutRequestId, "other-inflight-request")
    assert.equal(JSON.stringify(collection.calls[0]?.filter).includes("checkoutRequestId"), true)
  })

  it("keeps the entitlement and reservation filters intact", () => {
    const filter = checkoutClaimFilter(VENDOR, now) as {
      vendorId: string
      $and: unknown[]
    }
    const json = JSON.stringify(filter)

    assert.equal(filter.vendorId, VENDOR)
    assert.equal(filter.$and.length, 2)
    assert.equal(json.includes('"premium"'), true)
    assert.equal(json.includes('"trialing"'), true)
    assert.equal(json.includes("checkoutRequestId"), true)
  })

  it("admits exactly one claim across concurrent requests", async () => {
    const collection = new FakeSubscriptionCollection(now)

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        claimCheckoutReservation(
          collection.asCollection(),
          VENDOR,
          `request-${index}`,
          expiresAt,
          now,
        ),
      ),
    )

    assert.equal(results.filter(Boolean).length, 1)
    assert.equal(results.filter((result) => !result).length, 7)
    assert.equal(collection.docs.length, 1)
    assert.equal(
      collection.calls.every((call) => call.options.returnDocument === "after"),
      true,
    )
  })
})

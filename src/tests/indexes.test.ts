import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { INDEX_PLAN, ensureIndex, type IndexCollectionLike } from "../lib/indexes.js"

function fakeCollection(existing: Array<{ key: Record<string, number>; name: string }>) {
  const created: Array<{ spec: Record<string, number>; options: Record<string, unknown> }> = []
  const collection: IndexCollectionLike = {
    indexes: async () => existing,
    createIndex: async (spec, options) => {
      created.push({ spec: spec as Record<string, number>, options: options as Record<string, unknown> })
      return String(options.name)
    },
  }
  return { collection, created }
}

describe("MongoDB index initialization", () => {
  it("skips an equivalent key pattern under a different name", async () => {
    const { collection, created } = fakeCollection([
      { name: "legacy_role_index", key: { role: 1, createdAt: -1 } },
    ])

    await ensureIndex(collection, { role: 1, createdAt: -1 }, { name: "users_role_created" })
    assert.deepEqual(created, [])
  })

  it("creates a missing index with its explicit options", async () => {
    const { collection, created } = fakeCollection([{ name: "_id_", key: { _id: 1 } }])

    await ensureIndex(collection, { status: 1 }, { name: "bookings_status" })
    assert.equal(created.length, 1)
    assert.deepEqual(created[0]?.spec, { status: 1 })
    assert.equal(created[0]?.options.name, "bookings_status")
  })

  it("does not replace a unique index with the same keys", async () => {
    const { collection, created } = fakeCollection([
      { name: "users_email_uidx", key: { email: 1 } },
    ])

    await ensureIndex(collection, { email: 1 }, { name: "duplicate_email" })
    assert.deepEqual(created, [])
  })

  it("declares unique names and non-overlapping key patterns", () => {
    const names = INDEX_PLAN.map((plan) => plan.options.name)
    assert.equal(new Set(names).size, names.length)

    // The same key pattern is legal on different collections.
    const keys = INDEX_PLAN.map((plan) => JSON.stringify({ collection: plan.collection, spec: plan.spec }))
    assert.equal(new Set(keys).size, keys.length)

    // These already exist in production and must never be recreated here.
    assert.equal(
      keys.some((key) => key === JSON.stringify({ email: 1 })),
      false,
    )
    assert.equal(
      keys.some((key) => key === JSON.stringify({ stripeEventId: 1 })),
      false,
    )
    assert.equal(
      keys.some((key) => key === JSON.stringify({ vendorId: 1 })),
      false,
    )
  })
})

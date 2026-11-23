import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { getImgbbApiKey } from "../lib/imgbb.js"
import { getJwtVerificationConfig } from "../lib/jwt.js"
import { getDb } from "../lib/mongodb.js"
import {
  getPremiumPriceId,
  getStripe,
  getWebhookSecret,
} from "../lib/stripe.js"

const KEYS = [
  "MONGODB_URI",
  "STRIPE_SECRET_KEY",
  "STRIPE_PREMIUM_PRICE_ID",
  "STRIPE_WEBHOOK_SECRET",
  "IMGBB_API_KEY",
  "JWT_ISSUER",
  "JWT_AUDIENCE",
] as const

function withoutEnv<T>(fn: () => T): T {
  const previous = new Map<string, string | undefined>()
  for (const key of KEYS) {
    previous.set(key, process.env[key])
    delete process.env[key]
  }
  try {
    return fn()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function messageOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return error instanceof Error ? error.message : "unknown error"
  }
  assert.fail("expected configuration error")
}

describe("missing environment variables", () => {
  it("reports a clear MongoDB configuration error", async () => {
    const previousUri = process.env.MONGODB_URI
    delete process.env.MONGODB_URI
    try {
      await assert.rejects(() => getDb(), /MONGODB_URI/)
    } finally {
      if (previousUri === undefined) delete process.env.MONGODB_URI
      else process.env.MONGODB_URI = previousUri
    }
  })

  it("reports clear Stripe configuration errors without secrets", () => {
    assert.match(messageOf(() => withoutEnv(() => void getStripe())), /STRIPE_SECRET_KEY/)
    assert.match(
      messageOf(() => withoutEnv(() => void getPremiumPriceId())),
      /STRIPE_PREMIUM_PRICE_ID/,
    )
    assert.match(
      messageOf(() => withoutEnv(() => void getWebhookSecret())),
      /STRIPE_WEBHOOK_SECRET/,
    )
  })

  it("reports clear ImgBB and JWT configuration errors", () => {
    assert.match(messageOf(() => withoutEnv(() => getImgbbApiKey())), /IMGBB_API_KEY/)
    assert.match(
      messageOf(() => withoutEnv(() => getJwtVerificationConfig())),
      /JWT_ISSUER/,
    )
  })

  it("does not echo values in error messages", () => {
    const secret = "super-secret-value-that-must-never-appear"
    const message = withoutEnv(() => {
      process.env.STRIPE_WEBHOOK_SECRET = secret
      return messageOf(() => {
        delete process.env.STRIPE_WEBHOOK_SECRET
        getWebhookSecret()
      })
    })
    assert.equal(message.includes(secret), false)
  })
})

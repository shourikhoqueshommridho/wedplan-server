import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import type { AddressInfo } from "node:net"
import type { Server } from "node:http"
import { after, before, describe, it } from "node:test"
import type { NextFunction, Request, Response } from "express"
import type Stripe from "stripe"

import app from "../app.js"
import { getBrowserAuthUrl } from "../lib/auth.js"
import { getJwtVerificationConfig } from "../lib/jwt.js"
import { makeGetAuthContext, makeRequireRole, requireRole } from "../middleware/auth.js"
import {
  approveService,
  withApprovalLock,
  type ApprovalDeps,
} from "../services/service-approval.service.js"
import type { AuthContext } from "../types/auth.js"
import {
  buildSubscriptionSnapshot,
  canCreateActiveService,
  effectivePlan,
  isBlockedUser,
  isPremiumEntitled,
  mapStripeSubscriptionStatus,
  toMajorAmount,
} from "../services/subscriptions.service.js"
import {
  processStripeEvent,
  type WebhookContext,
} from "../services/stripe-webhook.service.js"
import type { SubscriptionSnapshotInput } from "../types/subscription.js"

const WEBHOOK_SECRET = "whsec_test_only_not_a_real_secret"
process.env.STRIPE_SECRET_KEY = "sk_test_unit_test_key"
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET
process.env.STRIPE_PREMIUM_PRICE_ID = "price_test_unit"

let server: Server
let port: number

before(async () => {
  server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance))
  })
  port = (server.address() as AddressInfo).port
})

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
})

function authContext(role: "customer" | "vendor" | "admin"): AuthContext {
  return {
    user: {
      id: "vendor-1",
      name: "Test Vendor",
      email: "vendor@example.test",
      emailVerified: true,
      image: null,
      role,
      createdAt: null,
    },
    session: { id: "session-1", expiresAt: null, createdAt: null },
  }
}

function event(type: string, object: unknown, id = `evt_${type}_1`): Stripe.Event {
  return { id, object: "event", type, data: { object } } as unknown as Stripe.Event
}

function stripeSubscription(status = "active"): Stripe.Subscription {
  return {
    id: "sub_test",
    status,
    metadata: { vendorId: "vendor-1" },
    customer: "cus_test",
    cancel_at_period_end: false,
    current_period_end: Math.floor(Date.now() / 1000) + 86_400,
    items: { data: [{ price: { id: "price_test_unit" } }] },
  } as unknown as Stripe.Subscription
}

function checkoutSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "cs_test",
    mode: "subscription",
    payment_status: "paid",
    metadata: { vendorId: "vendor-1" },
    client_reference_id: "vendor-1",
    customer: "cus_test",
    subscription: "sub_test",
    amount_total: 1999,
    currency: "usd",
    ...overrides,
  }
}

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: "in_test",
    parent: { subscription_details: { subscription: "sub_test" } },
    customer: "cus_test",
    amount_paid: 1999,
    amount_due: 1999,
    currency: "usd",
    ...overrides,
  }
}

function fakeContext(overrides: Partial<WebhookContext> = {}) {
  const snapshots: SubscriptionSnapshotInput[] = []
  let subscriptionStatus = "active"

  const context: WebhookContext = {
    vendorIdForSession: async () => "vendor-1",
    vendorIdForSubscription: async () => "vendor-1",
    vendorIdForCustomer: async () => "vendor-1",
    retrieveSubscription: async () => stripeSubscription(subscriptionStatus),
    commit: async (input) => {
      snapshots.push(input)
      return { duplicate: false }
    },
    ...overrides,
  }

  return {
    context,
    snapshots,
    setSubscriptionStatus: (value: string) => {
      subscriptionStatus = value
    },
  }
}

describe("checkout authorization", () => {
  it("rejects unauthenticated checkout and status requests", async () => {
    for (const path of ["/api/stripe/checkout", "/api/stripe/subscription"]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: path.endsWith("checkout") ? "POST" : "GET",
        headers: { "content-type": "application/json" },
        body: path.endsWith("checkout") ? "{}" : undefined,
      })
      assert.equal(response.status, 401)
      const payload = (await response.json()) as { success: boolean }
      assert.equal(payload.success, false)
    }
  })

  it("allows vendors but rejects customers and admins at the role gate", async () => {
    const gate = requireRole("vendor")

    for (const role of ["customer", "admin"] as const) {
      let status = 0
      const request = { auth: authContext(role) } as unknown as Request
      const response = {
        status: (value: number) => {
          status = value
          return response
        },
        json: () => response,
      } as unknown as Response

      await gate(request, response, (() => {
        assert.fail(`${role} must not pass the vendor gate`)
      }) as NextFunction)
      assert.equal(status, 403)
    }

    let passed = false
    await gate(
      { auth: authContext("vendor") } as unknown as Request,
      {} as unknown as Response,
      (() => {
        passed = true
      }) as NextFunction,
    )
    assert.equal(passed, true)
  })

  it("rejects an invalid bearer JWT and uses only JWT-derived roles", async () => {
    const invalid = makeGetAuthContext({
      verifyJwt: async () => {
        throw new Error("bad signature")
      },
      findUserById: async () => null,
      sessionContext: async () => null,
    })

    assert.equal(
      await invalid({ headers: { authorization: "Bearer forged" } } as unknown as Request),
      null,
    )

    const valid = makeGetAuthContext({
      verifyJwt: async () => ({ sub: "vendor-1", payload: { sub: "vendor-1" } }),
      findUserById: async (id) => ({
        id,
        name: "Test Vendor",
        email: "vendor@example.test",
        emailVerified: true,
        image: null,
        role: "vendor" as const,
        createdAt: null,
      }),
      sessionContext: async () => null,
    })
    const gate = makeRequireRole(["vendor"], valid)

    let passed = false
    await gate(
      { headers: { authorization: "Bearer valid" } } as unknown as Request,
      {} as unknown as Response,
      (() => {
        passed = true
      }) as NextFunction,
    )
    assert.equal(passed, true)
  })
})

describe("webhook signature verification", () => {
  it("rejects a missing or invalid signature", async () => {
    const payload = JSON.stringify({ id: "evt_unsigned", type: "payment_intent.created" })

    const missing = await fetch(`http://127.0.0.1:${port}/api/stripe/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    })
    assert.equal(missing.status, 400)

    const invalid = await fetch(`http://127.0.0.1:${port}/api/stripe/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=1,v1=deadbeef",
      },
      body: payload,
    })
    assert.equal(invalid.status, 400)
  })

  it("accepts a correctly signed raw payload and ignores unsupported events", async () => {
    const payload = JSON.stringify({ id: "evt_signed", type: "payment_intent.created" })
    const timestamp = Math.floor(Date.now() / 1000)
    const digest = createHmac("sha256", WEBHOOK_SECRET)
      .update(`${timestamp}.${payload}`)
      .digest("hex")

    const response = await fetch(`http://127.0.0.1:${port}/api/stripe/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": `t=${timestamp},v1=${digest}`,
      },
      body: payload,
    })

    assert.equal(response.status, 200)
    const body = (await response.json()) as {
      received: boolean
      processed: boolean
      ignored: boolean
    }
    assert.equal(body.received, true)
    assert.equal(body.processed, false)
    assert.equal(body.ignored, true)
  })
})

describe("webhook state machine", () => {
  it("activates Premium only after verifying an active Stripe subscription", async () => {
    const { context, snapshots, setSubscriptionStatus } = fakeContext()

    await processStripeEvent(
      event("checkout.session.completed", checkoutSession()),
      context,
    )
    assert.equal(snapshots.length, 1)
    assert.equal(snapshots[0]?.plan, "premium")
    assert.equal(snapshots[0]?.status, "active")
    assert.equal(snapshots[0]?.payment?.status, "paid")
    assert.equal(snapshots[0]?.payment?.amount, 19.99)

    setSubscriptionStatus("incomplete")
    await processStripeEvent(
      event("checkout.session.completed", checkoutSession({ id: "cs_second" }), "evt_second"),
      context,
    )
    assert.equal(snapshots[1]?.plan, "free")
    assert.equal(snapshots[1]?.status, "incomplete")
  })

  it("does not activate Premium for an unpaid asynchronous payment", async () => {
    const { context, snapshots } = fakeContext()
    await processStripeEvent(
      event("checkout.session.completed", checkoutSession({ payment_status: "unpaid" })),
      context,
    )
    assert.equal(snapshots[0]?.plan, "free")
    assert.equal(snapshots[0]?.status, "incomplete")
  })

  it("handles duplicate events idempotently", async () => {
    const seen = new Set<string>()
    const { context, snapshots } = fakeContext({
      commit: async (input) => {
        if (seen.has(input.eventId)) return { duplicate: true }
        seen.add(input.eventId)
        snapshots.push(input)
        return { duplicate: false }
      },
    })

    const checkout = event("checkout.session.completed", checkoutSession(), "evt_duplicate")
    const first = await processStripeEvent(checkout, context)
    const second = await processStripeEvent(checkout, context)

    assert.equal(first.duplicate, false)
    assert.equal(second.duplicate, true)
    assert.equal(snapshots.length, 1)
  })

  it("marks failed payments as past_due and revokes Premium", async () => {
    const { context, snapshots, setSubscriptionStatus } = fakeContext()
    setSubscriptionStatus("past_due")

    await processStripeEvent(event("invoice.payment_failed", invoice()), context)

    assert.equal(snapshots.length, 1)
    assert.equal(snapshots[0]?.plan, "free")
    assert.equal(snapshots[0]?.status, "past_due")
    assert.equal(snapshots[0]?.payment?.status, "failed")
  })

  it("marks cancellations as free/canceled", async () => {
    const { context, snapshots } = fakeContext()
    await processStripeEvent(
      event("customer.subscription.deleted", stripeSubscription("canceled")),
      context,
    )
    assert.equal(snapshots[0]?.plan, "free")
    assert.equal(snapshots[0]?.status, "canceled")
  })

  it("records renewals from paid invoices with the verified subscription state", async () => {
    const { context, snapshots } = fakeContext()
    await processStripeEvent(event("invoice.paid", invoice()), context)

    assert.equal(snapshots[0]?.plan, "premium")
    assert.equal(snapshots[0]?.status, "active")
    assert.equal(snapshots[0]?.payment?.status, "paid")
    assert.equal(snapshots[0]?.payment?.stripeSubscriptionId, "sub_test")
  })

  it("ignores an event whose subscription belongs to a different vendor", async () => {
    const { context, snapshots } = fakeContext({
      retrieveSubscription: async () => ({
        ...stripeSubscription("active"),
        metadata: { vendorId: "another-vendor" },
      }) as Stripe.Subscription,
    })

    const result = await processStripeEvent(
      event("checkout.session.completed", checkoutSession()),
      context,
    )
    assert.equal(result.ignored, true)
    assert.equal(result.reason, "vendor_mismatch")
    assert.equal(snapshots.length, 0)
  })

  it("activates on async_payment_succeeded after Stripe confirms the subscription", async () => {
    const { context, snapshots } = fakeContext()
    await processStripeEvent(
      event("checkout.session.async_payment_succeeded", checkoutSession(), "evt_async_success"),
      context,
    )
    assert.equal(snapshots[0]?.plan, "premium")
    assert.equal(snapshots[0]?.status, "active")
    assert.equal(snapshots[0]?.payment?.status, "paid")
  })

  it("syncs subscription.updated from the verified Stripe state", async () => {
    const active = fakeContext()
    await processStripeEvent(
      event("customer.subscription.updated", stripeSubscription("active"), "evt_updated_active"),
      active.context,
    )
    assert.equal(active.snapshots[0]?.plan, "premium")
    assert.equal(active.snapshots[0]?.status, "active")

    const delinquent = fakeContext()
    delinquent.setSubscriptionStatus("past_due")
    await processStripeEvent(
      event("customer.subscription.updated", stripeSubscription("past_due"), "evt_updated_past_due"),
      delinquent.context,
    )
    assert.equal(delinquent.snapshots[0]?.plan, "free")
    assert.equal(delinquent.snapshots[0]?.status, "past_due")
  })

  it("keeps Premium active when cancellation is scheduled for period end", async () => {
    const { context, snapshots } = fakeContext({
      retrieveSubscription: async () =>
        ({
          ...stripeSubscription("active"),
          cancel_at_period_end: true,
        }) as Stripe.Subscription,
    })

    await processStripeEvent(
      event("customer.subscription.updated", stripeSubscription("active"), "evt_cancel_scheduled"),
      context,
    )

    assert.equal(snapshots[0]?.plan, "premium")
    assert.equal(snapshots[0]?.status, "active")
    assert.equal(snapshots[0]?.cancelAtPeriodEnd, true)
  })

  it("does not revoke Premium early when Stripe still reports active on a failed invoice", async () => {
    const { context, snapshots } = fakeContext()
    await processStripeEvent(event("invoice.payment_failed", invoice()), context)

    assert.equal(snapshots[0]?.plan, "premium")
    assert.equal(snapshots[0]?.status, "active")
    assert.equal(snapshots[0]?.payment?.status, "failed")
  })

  it("expires Premium when Stripe reports an expired subscription", async () => {
    const { context, snapshots } = fakeContext()
    context.retrieveSubscription = async () => stripeSubscription("expired")

    await processStripeEvent(
      event("customer.subscription.updated", stripeSubscription("expired"), "evt_expired"),
      context,
    )

    assert.equal(snapshots[0]?.plan, "free")
    assert.equal(snapshots[0]?.status, "expired")
  })
})

describe("free plan service limits", () => {
  it("allows three active services for free vendors and unlimited for premium", () => {
    assert.equal(canCreateActiveService("free", 0), true)
    assert.equal(canCreateActiveService("free", 2), true)
    assert.equal(canCreateActiveService("free", 3), false)
    assert.equal(canCreateActiveService("premium", 100), true)
  })

  it("does not grant Premium from a stale or expired subscription record", () => {
    const expired = {
      plan: "premium" as const,
      status: "active" as const,
      currentPeriodEnd: new Date(Date.now() - 60_000),
    }
    assert.equal(isPremiumEntitled(expired), false)
    assert.equal(effectivePlan(expired), "free")
    assert.equal(
      isPremiumEntitled({ plan: "premium", status: "past_due", currentPeriodEnd: null }),
      false,
    )
    assert.equal(
      isPremiumEntitled({ plan: "premium", status: "active", currentPeriodEnd: null }),
      true,
    )
    assert.equal(
      effectivePlan({ plan: "premium", status: "canceled", currentPeriodEnd: null }),
      "free",
    )
    assert.equal(
      effectivePlan({ plan: "premium", status: "expired", currentPeriodEnd: null }),
      "free",
    )
  })

  it("detects blocked accounts", () => {
    assert.equal(isBlockedUser({ blocked: true }), true)
    assert.equal(isBlockedUser({ status: "blocked" }), true)
    assert.equal(isBlockedUser({ role: "vendor", status: "active" }), false)
  })

  it("maps Stripe statuses and converts amounts safely", () => {
    assert.equal(mapStripeSubscriptionStatus("past_due"), "past_due")
    assert.equal(mapStripeSubscriptionStatus("unknown"), "incomplete")
    assert.equal(toMajorAmount(1999, "usd"), 19.99)
    assert.equal(toMajorAmount(2000, "jpy"), 2000)
  })
})

describe("admin approval quota bypass", () => {
  function deps(overrides: Partial<ApprovalDeps> = {}) {
    const updates: Array<{ id: string; values: { status: string; isActive: boolean } }> = []
    const resolved: ApprovalDeps = {
      findService: async () => ({ vendorId: "vendor-1", isActive: false, status: "pending" }),
      updateService: async (id, values) => {
        updates.push({ id, values })
        return true
      },
      evaluateQuota: async () => ({ allowed: true, plan: "free", activeCount: 2, limit: 3 }),
      withLock: async (_vendorId, work) => work(),
      ...overrides,
    }
    return { resolved, updates }
  }

  it("blocks approval when a free vendor already has 3 active services", async () => {
    const { resolved, updates } = deps({
      evaluateQuota: async () => ({ allowed: false, plan: "free", activeCount: 3, limit: 3 }),
    })

    const result = await approveService("service-1", "approved", resolved)

    assert.deepEqual(result, {
      ok: false,
      reason: "quota",
      quota: { allowed: false, plan: "free", activeCount: 3, limit: 3 },
    })
    assert.equal(updates.length, 0)
  })

  it("allows premium vendors unlimited active services", async () => {
    const { resolved, updates } = deps({
      evaluateQuota: async () => ({ allowed: true, plan: "premium", activeCount: 20, limit: null }),
    })
    const result = await approveService("service-1", "approved", resolved)
    assert.deepEqual(result, { ok: true })
    assert.equal(updates.length, 1)
    assert.equal(updates[0]?.values.isActive, true)
  })

  it("allows approval below the limit and does not block a status-only approval", async () => {
    const below = deps()
    assert.deepEqual(await approveService("service-1", "approved", below.resolved), { ok: true })

    const alreadyActive = deps({
      findService: async () => ({ vendorId: "vendor-1", isActive: true, status: "pending" }),
      evaluateQuota: async () => {
        assert.fail("status-only approval must not query the quota")
      },
    })
    assert.deepEqual(await approveService("service-1", "approved", alreadyActive.resolved), {
      ok: true,
    })
    assert.equal(alreadyActive.updates.length, 1)
  })

  it("reverts the activation if a concurrent approval pushes the vendor over the limit", async () => {
    let calls = 0
    const { resolved, updates } = deps({
      evaluateQuota: async () => {
        calls += 1
        return calls === 1
          ? { allowed: true, plan: "free", activeCount: 2, limit: 3 }
          : { allowed: false, plan: "free", activeCount: 4, limit: 3 }
      },
    })

    const result = await approveService("service-1", "approved", resolved)

    assert.equal(result.ok, false)
    assert.equal(updates.length, 2)
    assert.deepEqual(updates[1]?.values, { status: "pending", isActive: false })
  })

  it("reports a missing service", async () => {
    const { resolved } = deps({ findService: async () => null })
    assert.deepEqual(await approveService("service-1", "approved", resolved), {
      ok: false,
      reason: "not_found",
    })
  })

  it("serializes concurrent approvals for the same vendor", async () => {
    let active = 0
    let maxActive = 0

    const run = () =>
      withApprovalLock("vendor-1", async () => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await Promise.resolve()
        active -= 1
      })

    await Promise.all([run(), run(), run()])
    assert.equal(maxActive, 1)
  })
})

describe("JWT and Better Auth URL resolution", () => {
  function withEnv(values: Record<string, string | undefined>, fn: () => void): void {
    const before = new Map<string, string | undefined>()
    for (const [key, value] of Object.entries(values)) {
      before.set(key, process.env[key])
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    try {
      fn()
    } finally {
      for (const [key, value] of before) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }

  it("uses the client origin as the auth base URL in production", () => {
    withEnv(
      {
        NODE_ENV: "production",
        BETTER_AUTH_URL: "http://localhost:3000",
        CLIENT_URL: "https://client.example.test",
      },
      () => {
        assert.equal(getBrowserAuthUrl(), "https://client.example.test")
      },
    )
  })

  it("keeps localhost URLs working in development", () => {
    withEnv(
      {
        NODE_ENV: "development",
        BETTER_AUTH_URL: "http://localhost:3000",
        CLIENT_URL: "https://wedplan-client-zeta.vercel.app",
        JWKS_URL: "http://localhost:3000/api/auth/jwks",
        JWT_ISSUER: "wedplan",
        JWT_AUDIENCE: "wedplan-api",
      },
      () => {
        assert.equal(getBrowserAuthUrl(), "http://localhost:3000")
        const config = getJwtVerificationConfig()
        assert.equal(config.jwksUrl, "http://localhost:3000/api/auth/jwks")
        assert.equal(config.issuer, "wedplan")
        assert.equal(config.audience, "wedplan-api")
        assert.deepEqual(config.algorithms, ["EdDSA"])
      },
    )
  })

  it("derives JWKS from the frontend endpoint when a deployed backend keeps a localhost JWKS_URL", () => {
    withEnv(
      {
        NODE_ENV: "production",
        BETTER_AUTH_URL: "http://localhost:3000",
        CLIENT_URL: "https://client.example.test",
        JWKS_URL: "http://localhost:3000/api/auth/jwks",
        JWT_ISSUER: "wedplan",
        JWT_AUDIENCE: "wedplan-api",
      },
      () => {
        assert.equal(
          getJwtVerificationConfig().jwksUrl,
          "https://client.example.test/api/auth/jwks",
        )
      },
    )
  })

  it("keeps an explicit non-local JWKS URL and still requires issuer and audience", () => {
    withEnv(
      {
        NODE_ENV: "production",
        JWKS_URL: "https://jwks.example.test/api/auth/jwks",
        JWT_ISSUER: "wedplan",
        JWT_AUDIENCE: "wedplan-api",
      },
      () => {
        assert.equal(getJwtVerificationConfig().jwksUrl, "https://jwks.example.test/api/auth/jwks")
      },
    )

    withEnv(
      {
        NODE_ENV: "production",
        JWKS_URL: "https://jwks.example.test/api/auth/jwks",
        JWT_ISSUER: undefined,
        JWT_AUDIENCE: "wedplan-api",
      },
      () => {
        assert.throws(() => getJwtVerificationConfig())
      },
    )
  })
})

describe("subscription GET snapshot", () => {
  type RecordInput = NonNullable<Parameters<typeof buildSubscriptionSnapshot>[0]>

  function subscriptionRecord(overrides: Record<string, unknown> = {}): RecordInput {
    return {
      vendorId: "vendor-1",
      plan: "premium",
      status: "active",
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
      cancelAtPeriodEnd: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    } as unknown as RecordInput
  }

  it("returns a consistent Free snapshot for a vendor without a subscription", () => {
    const snapshot = buildSubscriptionSnapshot(null, 2)
    assert.equal(snapshot.plan, "free")
    assert.equal(snapshot.status, "none")
    assert.equal(snapshot.active, false)
    assert.equal(snapshot.serviceLimit, 3)
    assert.equal(snapshot.canCreateService, true)
  })

  it("returns a consistent Premium snapshot for an active subscriber", () => {
    const snapshot = buildSubscriptionSnapshot(subscriptionRecord(), 5)
    assert.equal(snapshot.plan, "premium")
    assert.equal(snapshot.status, "active")
    assert.equal(snapshot.active, true)
    assert.equal(snapshot.serviceLimit, null)
    assert.equal(snapshot.canCreateService, true)
    assert.notEqual(snapshot.renewalDate, null)
  })

  it("keeps Premium until the paid period ends when cancellation is scheduled", () => {
    const snapshot = buildSubscriptionSnapshot(
      subscriptionRecord({ cancelAtPeriodEnd: true }),
      5,
    )
    assert.equal(snapshot.active, true)
    assert.equal(snapshot.cancelAtPeriodEnd, true)
    assert.equal(snapshot.serviceLimit, null)
  })

  it("restores Free after actual expiration", () => {
    const snapshot = buildSubscriptionSnapshot(
      subscriptionRecord({ status: "expired", currentPeriodEnd: new Date(Date.now() - 60_000) }),
      5,
    )
    assert.equal(snapshot.plan, "free")
    assert.equal(snapshot.active, false)
    assert.equal(snapshot.serviceLimit, 3)
    assert.equal(snapshot.canCreateService, false)
  })
})

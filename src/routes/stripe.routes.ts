import { randomUUID } from "node:crypto"
import { Router, type RequestHandler } from "express"
import Stripe from "stripe"

import {
  checkoutDiagEnabled,
  checkoutDiagFor,
  safeErrorInfo,
} from "../lib/checkout-diagnostics.js"
import {
  getClientUrl,
  getPremiumPriceId,
  getStripe,
  isStripeConfigured,
} from "../lib/stripe.js"
import { requireRole } from "../middleware/auth.js"
import { requireActiveUser } from "../middleware/blocked.js"
import {
  getSubscription,
  getSubscriptionSnapshot,
  isCheckoutSessionOpen,
  isPremiumEntitled,
  markCheckoutPending,
} from "../services/subscriptions.service.js"

const stripeRouter = Router()

/**
 * Logs stage entry/exit/errors around an existing middleware without changing
 * what the middleware does. Only stage names, status codes, error class names
 * and numeric codes are logged.
 */
function trace(name: string, handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    if (!checkoutDiagEnabled()) {
      handler(req, res, next)
      return
    }

    checkoutDiagFor(res, "middleware-enter", { stage: name })
    let settled = false
    const done = (error?: unknown): void => {
      if (settled) return
      settled = true

      if (error) {
        const info = safeErrorInfo(error)
        checkoutDiagFor(res, "middleware-error", {
          stage: name,
          errorName: info.errorName,
          errorCode: info.errorCode,
        })
      } else {
        checkoutDiagFor(res, "middleware-exit", { stage: name, status: res.statusCode })
      }

      next(error)
    }

    try {
      const result = handler(req, res, done) as unknown
      if (result && typeof (result as Promise<unknown>).catch === "function") {
        ;(result as Promise<unknown>).catch(done)
      }
    } catch (error) {
      done(error)
    }
  }
}

stripeRouter.use((req, res, next) => {
  if (checkoutDiagEnabled()) {
    const requestId = req.header("x-checkout-diagnostic-id") || randomUUID()
    res.locals.checkoutDiagId = requestId
    checkoutDiagFor(res, "backend-arrival", {
      method: req.method,
      path: `${req.baseUrl}${req.path}`,
    })
    res.once("finish", () => {
      checkoutDiagFor(res, "backend-finish", { status: res.statusCode })
    })
    res.once("close", () => {
      if (!res.writableEnded) checkoutDiagFor(res, "backend-close", { status: res.statusCode })
    })
  }
  next()
})

// Authorization is unchanged: the same role gate and blocked-user gate run in
// the same order, only wrapped with stage diagnostics.
stripeRouter.use(trace("role-gate", requireRole("vendor")))
stripeRouter.use(trace("blocked-gate", requireActiveUser))

stripeRouter.use((req, res, next) => {
  checkoutDiagFor(res, "backend-authenticated", { role: req.auth?.user.role ?? null })
  next()
})

/** POST /api/stripe/checkout — creates a hosted Stripe Checkout Session. */
stripeRouter.post("/checkout", async (req, res, next) => {
  try {
    if (!isStripeConfigured()) {
      res.status(503).json({
        success: false,
        message: "Premium subscriptions are not configured yet. Please try again later.",
      })
      return
    }

    const vendorId = req.auth!.user.id
    checkoutDiagFor(res, "checkout-handler", { authenticated: true })
    const priceId = getPremiumPriceId()
    const stripe = getStripe()
    const existing = await getSubscription(vendorId)

    if (isPremiumEntitled(existing)) {
      res.status(409).json({
        success: false,
        message: "You already have an active Premium subscription.",
      })
      return
    }

    // Do not create a second Checkout Session while the previous one is still
    // open and unused.
    if (existing?.stripeSessionId) {
      try {
        const previous = await stripe.checkout.sessions.retrieve(existing.stripeSessionId)
        if (
          isCheckoutSessionOpen(previous) &&
          previous.mode === "subscription" &&
          previous.metadata?.vendorId === vendorId &&
          previous.url
        ) {
          res.status(200).json({
            success: true,
            data: { url: previous.url, sessionId: previous.id },
          })
          return
        }
      } catch {
        // An expired/deleted session just means we should create a new one.
      }
    }

    // The local record can lag behind Stripe. Reject if Stripe already has an
    // active subscription for this vendor's customer using the premium price.
    if (existing?.stripeCustomerId) {
      const activeSubscriptions = await stripe.subscriptions.list({
        customer: existing.stripeCustomerId,
        status: "active",
        limit: 10,
      })
      const alreadySubscribed = activeSubscriptions.data.some((subscription) =>
        subscription.items.data.some((item) => item.price.id === priceId),
      )
      if (alreadySubscribed) {
        res.status(409).json({
          success: false,
          message: "You already have an active Premium subscription.",
        })
        return
      }
    }

    const clientUrl = getClientUrl()
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: vendorId,
      metadata: { vendorId },
      subscription_data: { metadata: { vendorId } },
      ...(existing?.stripeCustomerId
        ? { customer: existing.stripeCustomerId }
        : { customer_email: req.auth!.user.email }),
      success_url: `${clientUrl}/dashboard/vendor/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${clientUrl}/dashboard/vendor/payment/cancel`,
      allow_promotion_codes: true,
    })

    if (!session.url) {
      res.status(502).json({
        success: false,
        message: "Stripe did not return a Checkout URL. Please try again.",
      })
      return
    }

    await markCheckoutPending(vendorId, session.id, session.customer ? String(
      typeof session.customer === "string" ? session.customer : session.customer.id,
    ) : null)

    checkoutDiagFor(res, "checkout-success", { status: 200 })
    res.status(200).json({
      success: true,
      data: { url: session.url, sessionId: session.id },
    })
  } catch (error) {
    const stripeError = error instanceof Stripe.errors.StripeError ? error : null
    const meta = stripeError as unknown as {
      statusCode?: number
      type?: string
      code?: string
    } | null
    checkoutDiagFor(res, "checkout-error", {
      status: meta?.statusCode ?? null,
      errorType: meta?.type ?? null,
      errorCode: meta?.code ?? null,
      isStripeError: stripeError !== null,
    })

    if (stripeError) {
      res.status(502).json({
        success: false,
        message: "Stripe could not start checkout. Please try again.",
      })
      return
    }
    next(error)
  }
})

/** GET /api/stripe/subscription — current plan, status and service quota. */
stripeRouter.get("/subscription", async (req, res, next) => {
  try {
    const snapshot = await getSubscriptionSnapshot(req.auth!.user.id)
    res.status(200).json({ success: true, data: snapshot })
  } catch (error) {
    next(error)
  }
})

export default stripeRouter

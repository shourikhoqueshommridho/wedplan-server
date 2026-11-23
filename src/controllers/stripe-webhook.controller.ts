import type { NextFunction, Request, Response } from "express"
import type Stripe from "stripe"

import { getStripe, getWebhookSecret, isStripeSignatureError } from "../lib/stripe.js"
import {
  commitSubscriptionSnapshot,
  getSubscriptionByCustomer,
  getSubscriptionBySession,
  getSubscriptionByStripeSubscriptionId,
} from "../services/subscriptions.service.js"
import { processStripeEvent, type WebhookContext } from "../services/stripe-webhook.service.js"

function createWebhookContext(): WebhookContext {
  return {
    vendorIdForSession: async (sessionId) => {
      const local = await getSubscriptionBySession(sessionId)
      if (local) return local.vendorId

      const session = await getStripe().checkout.sessions.retrieve(sessionId)
      return (
        session.metadata?.vendorId ??
        (typeof session.client_reference_id === "string" ? session.client_reference_id : null)
      )
    },

    vendorIdForSubscription: async (stripeSubscriptionId, metadataVendorId) => {
      if (metadataVendorId) return metadataVendorId

      const local = await getSubscriptionByStripeSubscriptionId(stripeSubscriptionId)
      if (local) return local.vendorId

      const subscription = await getStripe().subscriptions.retrieve(stripeSubscriptionId)
      return subscription.metadata?.vendorId ?? null
    },

    vendorIdForCustomer: async (customerId) => {
      const local = await getSubscriptionByCustomer(customerId)
      return local?.vendorId ?? null
    },

    retrieveSubscription: async (stripeSubscriptionId) =>
      getStripe().subscriptions.retrieve(stripeSubscriptionId),

    commit: commitSubscriptionSnapshot,
  }
}

/**
 * POST /api/stripe/webhook — mounted with express.raw() before express.json()
 * so the signed payload is verified byte-for-byte.
 */
export async function stripeWebhookHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const header = req.headers["stripe-signature"]
    const signature = Array.isArray(header) ? header[0] : header

    if (!signature) {
      res.status(400).json({ success: false, message: "Missing Stripe signature." })
      return
    }

    if (!Buffer.isBuffer(req.body)) {
      res.status(400).json({ success: false, message: "Invalid webhook payload." })
      return
    }

    let event: Stripe.Event
    try {
      event = getStripe().webhooks.constructEvent(req.body, signature, getWebhookSecret())
    } catch (error) {
      if (isStripeSignatureError(error)) {
        res.status(400).json({ success: false, message: "Invalid Stripe signature." })
        return
      }
      throw error
    }

    const result = await processStripeEvent(event, createWebhookContext())
    res.status(200).json({ received: true, ...result })
  } catch (error) {
    next(error)
  }
}

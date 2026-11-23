import Stripe from "stripe"

/**
 * Stripe is configured only from server environment variables. No key, price
 * id, or webhook secret is ever sent to the browser.
 */
let client: Stripe | null = null

function readEnv(name: string): string | null {
  const value = process.env[name]?.trim()
  return value || null
}

export function getStripe(): Stripe {
  const secretKey = readEnv("STRIPE_SECRET_KEY")

  if (!secretKey) {
    throw new Error("STRIPE_SECRET_KEY is not configured")
  }

  client ??= new Stripe(secretKey)
  return client
}

export function getPremiumPriceId(): string {
  const priceId = readEnv("STRIPE_PREMIUM_PRICE_ID")

  if (!priceId) {
    throw new Error("STRIPE_PREMIUM_PRICE_ID is not configured")
  }

  return priceId
}

export function getWebhookSecret(): string {
  const secret = readEnv("STRIPE_WEBHOOK_SECRET")

  if (!secret) {
    throw new Error("STRIPE_WEBHOOK_SECRET is not configured")
  }

  return secret
}

/** Browser-facing origin used for Checkout success/cancel redirects. */
export function getClientUrl(): string {
  return (readEnv("CLIENT_URL") || "http://localhost:3000").replace(/\/+$/, "")
}

export function isStripeConfigured(): boolean {
  return Boolean(
    readEnv("STRIPE_SECRET_KEY") &&
      readEnv("STRIPE_WEBHOOK_SECRET") &&
      readEnv("STRIPE_PREMIUM_PRICE_ID"),
  )
}

/** True only for signature-verification failures, never for API errors. */
export function isStripeSignatureError(error: unknown): boolean {
  return (
    error instanceof Stripe.errors.StripeSignatureVerificationError ||
    (error instanceof Error && error.message.includes("signature verification"))
  )
}

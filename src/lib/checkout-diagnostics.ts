import type { Response } from "express"

/**
 * Opt-in, sanitized diagnostics for the checkout request path.
 * Never log headers, tokens, cookies, env values, vendor ids or payment data.
 */
export function checkoutDiagEnabled(): boolean {
  return process.env.STRIPE_CHECKOUT_DIAGNOSTICS === "1"
}

export function checkoutDiag(
  event: string,
  fields: Record<string, string | number | boolean | null>,
): void {
  if (!checkoutDiagEnabled()) return
  console.warn("[checkout-diag]", event, JSON.stringify(fields))
}

export function checkoutDiagFor(
  res: Response,
  event: string,
  fields: Record<string, string | number | boolean | null> = {},
): void {
  const value = res.locals?.checkoutDiagId
  checkoutDiag(event, {
    requestId: typeof value === "string" ? value : null,
    ...fields,
  })
}

/** Only an error class name and numeric code are ever emitted — no messages. */
export function safeErrorInfo(error: unknown): {
  errorName: string
  errorCode: number | null
} {
  const candidate = error as { name?: unknown; code?: unknown } | null
  return {
    errorName: typeof candidate?.name === "string" ? candidate.name.slice(0, 80) : "UnknownError",
    errorCode: typeof candidate?.code === "number" ? candidate.code : null,
  }
}

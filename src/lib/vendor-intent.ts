import { createHmac, timingSafeEqual } from "node:crypto"

import type { VendorBusinessDetails } from "../types/vendor.js"
import { vendorBusinessDetailsSchema } from "../validators/vendor.js"

export const VENDOR_INTENT_COOKIE = "wedplan_vendor_intent"
export const VENDOR_INTENT_TTL_SECONDS = 15 * 60

const MAX_TOKEN_LENGTH = 8_192

interface VendorIntentPayload extends VendorBusinessDetails {
  v: 1
  exp: number
}

function getSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET?.trim()

  if (!secret) {
    throw new Error("BETTER_AUTH_SECRET is not configured")
  }

  return secret
}

function sign(value: string): string {
  return createHmac("sha256", getSecret()).update(value).digest("base64url")
}

/**
 * Creates a short-lived, signed cookie value that carries the vendor business
 * details through the Google OAuth round trip. The role is only granted when
 * Better Auth creates a brand-new user and this signature verifies.
 */
export function createVendorIntentToken(details: VendorBusinessDetails): string {
  const payload: VendorIntentPayload = {
    v: 1,
    ...details,
    exp: Math.floor(Date.now() / 1000) + VENDOR_INTENT_TTL_SECONDS,
  }
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")

  return `${encoded}.${sign(encoded)}`
}

export function readVendorIntentToken(token: string | null | undefined): VendorBusinessDetails | null {
  if (!token || token.length > MAX_TOKEN_LENGTH) return null

  const [encoded, signature, ...rest] = token.split(".")
  if (!encoded || !signature || rest.length > 0) return null

  const expected = sign(encoded)
  const providedBuffer = Buffer.from(signature)
  const expectedBuffer = Buffer.from(expected)

  if (
    providedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))

    if (typeof parsed !== "object" || parsed === null) return null

    const record = parsed as Record<string, unknown>
    if (record.v !== 1) return null
    if (typeof record.exp !== "number" || record.exp <= Math.floor(Date.now() / 1000)) return null

    const details = vendorBusinessDetailsSchema.safeParse({
      businessName: record.businessName,
      category: record.category,
      phone: record.phone,
      location: record.location,
      website: record.website ?? undefined,
      description: record.description,
    })

    return details.success ? details.data : null
  } catch {
    return null
  }
}

export function vendorIntentCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    // Express serialises `maxAge` from milliseconds into the Max-Age seconds
    // attribute, so the 15-minute token lifetime is converted here.
    maxAge: VENDOR_INTENT_TTL_SECONDS * 1000,
  }
}

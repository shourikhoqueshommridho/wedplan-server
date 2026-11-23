import { betterAuth } from "better-auth"
import { mongodbAdapter } from "better-auth/adapters/mongodb"
import { jwt } from "better-auth/plugins"
import { toNodeHandler } from "better-auth/node"

import { getDb } from "./mongodb.js"
import { readVendorIntentToken, VENDOR_INTENT_COOKIE } from "./vendor-intent.js"
import { upsertVendorProfile } from "../services/vendors.service.js"
import type { UserRole } from "../types/auth.js"

const DEFAULT_AUTH_URL = "http://localhost:3000"
const DEFAULT_CLIENT_URL = "http://localhost:3000"
const LOCAL_CLIENT_ORIGIN = "http://localhost:3000"
/** Exact frontend production origin; preview deployments are not trusted. */
const PRODUCTION_CLIENT_ORIGIN = "https://wedplan-client-zeta.vercel.app"

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "")
}

export function isLocalOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    )
  } catch {
    return false
  }
}

/** Vercel exposes its deployment host without a scheme. */
function getVercelOrigin(): string | null {
  const configured =
    process.env.VERCEL_PRODUCTION_URL?.trim() || process.env.VERCEL_URL?.trim()
  if (!configured) return null

  const host = trimTrailingSlashes(configured.replace(/^https?:\/\//i, ""))
  return host ? `https://${host}` : null
}

/**
 * Resolve a browser-facing origin. An explicit non-local value always wins.
 * A localhost value in production is the stale development default, so derive
 * the public origin from the Vercel host instead of breaking callbacks/CORS.
 */
function resolvePublicOrigin(configured: string | undefined, fallback: string): string {
  const value = configured?.trim()
  const isProduction = process.env.NODE_ENV === "production"

  if (value && !(isProduction && isLocalOrigin(value))) {
    return trimTrailingSlashes(value)
  }

  if (isProduction) {
    const vercelOrigin = getVercelOrigin()
    if (vercelOrigin) return vercelOrigin
  }

  return trimTrailingSlashes(fallback)
}

/**
 * The public origin that serves `/api/auth`. In this project the Next.js app
 * owns that path and proxies it to this Express server, so the base URL must
 * stay the browser-facing origin (used for OAuth callbacks and cookies).
 */
/**
 * The browser-facing origin that serves `/api/auth`. The Next.js app owns that
 * path and proxies it to this API, so in production this must be the client
 * origin (not the backend's Vercel host). Local development keeps its explicit
 * localhost value so cookies and JWKS URLs resolve correctly.
 */
export function getBrowserAuthUrl(): string {
  const configured = process.env.BETTER_AUTH_URL?.trim()

  if (configured && !isLocalOrigin(configured)) return trimTrailingSlashes(configured)

  if (process.env.NODE_ENV === "production") {
    const client = process.env.CLIENT_URL?.trim()
    if (client && !isLocalOrigin(client)) return trimTrailingSlashes(client)
    return PRODUCTION_CLIENT_ORIGIN
  }

  return trimTrailingSlashes(configured || DEFAULT_AUTH_URL)
}

export function getAuthBaseUrl(): string {
  return getBrowserAuthUrl()
}

export function getClientUrl(): string {
  return resolvePublicOrigin(process.env.CLIENT_URL, DEFAULT_CLIENT_URL)
}

export function getTrustedOrigins(): string[] {
  const origins = new Set<string>()

  // Only explicitly configured, non-local origins are trusted from the
  // environment. VERCEL_URL is deliberately not used here: on preview
  // deployments it would trust an untrusted preview host.
  for (const configured of [process.env.BETTER_AUTH_URL, process.env.CLIENT_URL]) {
    const value = configured?.trim()
    if (value && !isLocalOrigin(value)) {
      origins.add(trimTrailingSlashes(value))
    }
  }

  if (process.env.NODE_ENV === "production") {
    // The known frontend production origin, independent of the backend's
    // VERCEL_* values (which describe this server, not the browser origin).
    origins.add(PRODUCTION_CLIENT_ORIGIN)
  } else {
    origins.add(LOCAL_CLIENT_ORIGIN)
  }

  return Array.from(origins)
}

function googleProvider():
  | { google: { clientId: string; clientSecret: string } }
  | undefined {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim()
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim()

  if (!clientId || !clientSecret) {
    return undefined
  }

  return { google: { clientId, clientSecret } }
}

async function createAuth() {
  const db = await getDb()
  // Explicit values keep issuance and verification identical across local and
  // Vercel deployments (Vercel host names vary per preview deployment).
  const jwtIssuer = process.env.JWT_ISSUER?.trim() || getAuthBaseUrl()
  const jwtAudience = process.env.JWT_AUDIENCE?.trim() || getAuthBaseUrl()

  return betterAuth({
    appName: "WedPlan",
    baseURL: getAuthBaseUrl(),
    secret: process.env.BETTER_AUTH_SECRET,
    trustedOrigins: getTrustedOrigins(),
    database: mongodbAdapter(db, { usePlural: true }),
    plugins: [
      jwt({
        jwt: {
          issuer: jwtIssuer,
          audience: jwtAudience,
          expirationTime: "15m",
          /**
           * Keep the token free of user data. The Express verifier resolves
           * `sub` against MongoDB and derives the role there — a role claim in
           * a token is never trusted.
           */
          definePayload: () => ({}),
        },
        // jwks options are deliberately left at their secure defaults:
        // EdDSA/Ed25519 keys and private keys encrypted with BETTER_AUTH_SECRET.
      }),
    ],
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      requireEmailVerification: false,
    },
    socialProviders: googleProvider(),
    user: {
      additionalFields: {
        // `input: false` keeps the field out of public sign-up payloads.
        role: {
          type: "string",
          required: false,
          defaultValue: "customer" satisfies UserRole,
          input: false,
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user, context) => {
            /**
             * Public sign-up always starts as a customer. The only exception is
             * a freshly created account that arrives through the vendor sign-up
             * flow with a valid signed intent cookie. Existing users never run
             * this hook, so an existing customer cannot be converted through
             * Google sign-in.
             */
            const intent = context
              ? readVendorIntentToken(context.getCookie(VENDOR_INTENT_COOKIE))
              : null

            return {
              data: {
                ...user,
                role: (intent ? "vendor" : "customer") satisfies UserRole,
              },
            }
          },
          after: async (user, context) => {
            if (user.role !== "vendor" || !context) return

            const intent = readVendorIntentToken(context.getCookie(VENDOR_INTENT_COOKIE))
            if (!intent) return

            try {
              await upsertVendorProfile(user.id, user.email, intent)
            } catch (error) {
              // The account and session are still valid. The vendor dashboard
              // asks the owner to complete the profile if it is missing.
              console.error(
                "[wedplan-api] Could not create the vendor profile after OAuth sign-up:",
                error instanceof Error ? error.message : "unknown error",
              )
            }
          },
        },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    advanced: {
      useSecureCookies: process.env.NODE_ENV === "production",
    },
  })
}

let authPromise: ReturnType<typeof createAuth> | null = null

/** Lazily creates the single Better Auth instance for this process. */
export function getAuth(): ReturnType<typeof createAuth> {
  authPromise ??= createAuth().catch((error: unknown) => {
    authPromise = null
    throw error
  })

  return authPromise
}

let handlerPromise: Promise<ReturnType<typeof toNodeHandler>> | null = null

/**
 * Cached Node request handler. Express mounts it at `/api/auth/*splat` before
 * the JSON body parser so Better Auth can read the raw request stream.
 */
export function getAuthHandler(): Promise<ReturnType<typeof toNodeHandler>> {
  handlerPromise ??= getAuth()
    .then((auth) => toNodeHandler(auth))
    .catch((error: unknown) => {
      handlerPromise = null
      throw error
    })

  return handlerPromise
}

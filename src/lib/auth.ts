import { betterAuth } from "better-auth"
import { mongodbAdapter } from "better-auth/adapters/mongodb"
import { toNodeHandler } from "better-auth/node"

import { getDb } from "./mongodb.js"
import { readVendorIntentToken, VENDOR_INTENT_COOKIE } from "./vendor-intent.js"
import { upsertVendorProfile } from "../services/vendors.service.js"
import type { UserRole } from "../types/auth.js"

const DEFAULT_AUTH_URL = "http://localhost:3000"
const DEFAULT_CLIENT_URL = "http://localhost:3000"

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "")
}

/**
 * The public origin that serves `/api/auth`. In this project the Next.js app
 * owns that path and proxies it to this Express server, so the base URL must
 * stay the browser-facing origin (used for OAuth callbacks and cookies).
 */
export function getAuthBaseUrl(): string {
  return trimTrailingSlashes(process.env.BETTER_AUTH_URL?.trim() || DEFAULT_AUTH_URL)
}

export function getClientUrl(): string {
  return trimTrailingSlashes(process.env.CLIENT_URL?.trim() || DEFAULT_CLIENT_URL)
}

export function getTrustedOrigins(): string[] {
  return Array.from(new Set([getAuthBaseUrl(), getClientUrl(), "http://localhost:3000"]))
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

  return betterAuth({
    appName: "WedPlan",
    baseURL: getAuthBaseUrl(),
    secret: process.env.BETTER_AUTH_SECRET,
    trustedOrigins: getTrustedOrigins(),
    database: mongodbAdapter(db, { usePlural: true }),
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

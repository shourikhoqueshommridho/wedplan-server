import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose"

import { getBrowserAuthUrl, isLocalOrigin } from "./auth.js"

/**
 * The JWT plugin signs with EdDSA/Ed25519 by default. Keeping the allow-list
 * explicit prevents an attacker from selecting a weaker algorithm.
 */
const DEFAULT_ALGORITHMS = ["EdDSA"] as const

export interface JwtVerificationConfig {
  jwksUrl: string
  issuer: string
  audience: string
  algorithms: readonly string[]
}

export interface VerifiedToken {
  sub: string
  payload: JWTPayload
}

/**
 * The JWKS endpoint is served by Better Auth through the frontend proxy. An
 * explicit non-local JWKS_URL still wins; a stale localhost value in a deployed
 * backend is replaced with the browser-facing `/api/auth/jwks` URL.
 */
function resolveJwksUrl(): string {
  const configured = process.env.JWKS_URL?.trim()

  if (configured && !(process.env.NODE_ENV === "production" && isLocalOrigin(configured))) {
    return configured
  }

  return `${getBrowserAuthUrl()}/api/auth/jwks`
}

/** Reads verifier settings from the environment; no secrets are involved. */
export function getJwtVerificationConfig(): JwtVerificationConfig {
  const jwksUrl = resolveJwksUrl()
  const issuer = process.env.JWT_ISSUER?.trim()
  const audience = process.env.JWT_AUDIENCE?.trim()

  if (!issuer || !audience) {
    throw new Error(
      "JWT verification is not configured (JWT_ISSUER and JWT_AUDIENCE are required)",
    )
  }

  return { jwksUrl, issuer, audience, algorithms: DEFAULT_ALGORITHMS }
}

function makeVerifier(getKey: JWTVerifyGetKey, config: JwtVerificationConfig) {
  return async function verifyJwt(token: string): Promise<VerifiedToken> {
    // jose verifies the signature, `exp`, `nbf`, issuer, audience and algorithm.
    const { payload } = await jwtVerify(token, getKey, {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: [...config.algorithms],
    })

    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      throw new Error("JWT is missing a subject")
    }

    return { sub: payload.sub, payload }
  }
}

export type JwtVerifier = ReturnType<typeof makeVerifier>

/**
 * Production verifier: JWKS keys are fetched from the public, proxied
 * /api/auth/jwks endpoint and cached by jose, including `kid` changes.
 */
export function createJwtVerifier(
  config: JwtVerificationConfig = getJwtVerificationConfig(),
): JwtVerifier {
  return makeVerifier(createRemoteJWKSet(new URL(config.jwksUrl)), config)
}

/** In-memory JWKS verifier used by unit tests (no network, no database). */
export function createJwtVerifierFromJwks(
  jwks: JSONWebKeySet,
  config: Omit<JwtVerificationConfig, "jwksUrl">,
): JwtVerifier {
  return makeVerifier(createLocalJWKSet(jwks), { ...config, jwksUrl: "" })
}

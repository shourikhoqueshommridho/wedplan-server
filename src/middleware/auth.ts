import type { NextFunction, Request, RequestHandler, Response } from "express"
import { fromNodeHeaders } from "better-auth/node"

import { getAuth } from "../lib/auth.js"
import { createJwtVerifier, type JwtVerifier, type VerifiedToken } from "../lib/jwt.js"
import { findAuthUserById, type AuthUserIdentity } from "../services/users.service.js"
import {
  normalizeUserRole,
  type AuthContext,
  type AuthenticatedSession,
  type AuthenticatedUser,
  type UserRole,
} from "../types/auth.js"

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext
    }
  }
}

function toIsoString(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "number") {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
  }
  if (typeof value === "string") {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
  }
  return null
}

type BearerHeader = { present: false } | { present: true; token: string }

/** Distinguishes "no Bearer header" from "Bearer header with an invalid token". */
function readBearerHeader(req: Request): BearerHeader {
  const header = req.headers.authorization
  if (typeof header !== "string" || !/^Bearer(?:\s|$)/i.test(header)) {
    return { present: false }
  }
  return { present: true, token: header.replace(/^Bearer\s+/i, "").trim() }
}

/**
 * Validates the Better Auth session cookie against the database. The user and
 * role are derived here from the verified session — never from request input.
 * This is the original authentication path and is intentionally unchanged.
 */
export async function getSessionAuthContext(req: Request): Promise<AuthContext | null> {
  // No cookie means there cannot be a session. Avoid initializing auth (and
  // touching MongoDB) for plainly unauthenticated calls.
  if (!req.headers.cookie) return null

  const auth = await getAuth()
  const result = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  })

  if (!result?.user || !result.session) return null

  const user: AuthenticatedUser = {
    id: result.user.id,
    name: result.user.name,
    email: result.user.email,
    emailVerified: Boolean(result.user.emailVerified),
    image: result.user.image ?? null,
    role: normalizeUserRole(result.user.role),
    createdAt: toIsoString(result.user.createdAt),
  }

  const session: AuthenticatedSession = {
    id: result.session.id,
    expiresAt: toIsoString(result.session.expiresAt),
    createdAt: toIsoString(result.session.createdAt),
  }

  return { user, session }
}

export interface AuthContextDeps {
  verifyJwt: JwtVerifier
  findUserById: (id: string) => Promise<AuthUserIdentity | null>
  sessionContext: (req: Request) => Promise<AuthContext | null>
}

function jwtContext(identity: AuthUserIdentity, verified: VerifiedToken): AuthContext {
  return {
    user: {
      id: identity.id,
      name: identity.name,
      email: identity.email,
      emailVerified: identity.emailVerified,
      image: identity.image,
      role: identity.role,
      createdAt: identity.createdAt,
    },
    // A stateless JWT has no database session row. Timestamps come from claims.
    session: {
      id: typeof verified.payload.jti === "string" ? verified.payload.jti : "",
      expiresAt: toIsoString(
        typeof verified.payload.exp === "number" ? verified.payload.exp * 1000 : null,
      ),
      createdAt: toIsoString(
        typeof verified.payload.iat === "number" ? verified.payload.iat * 1000 : null,
      ),
    },
  }
}

let defaultVerifier: JwtVerifier | null = null
function getDefaultDeps(): AuthContextDeps {
  return {
    // Created on first Bearer request only, so cookie-only traffic never
    // depends on JWT environment configuration being present.
    verifyJwt: (token) => {
      defaultVerifier ??= createJwtVerifier()
      return defaultVerifier(token)
    },
    findUserById: findAuthUserById,
    sessionContext: getSessionAuthContext,
  }
}

/**
 * Creates the resolver used by both middleware factories. A Bearer token is
 * always authoritative when present: if it is invalid, authentication fails
 * instead of silently falling back to a valid session cookie.
 */
export function makeGetAuthContext(deps: AuthContextDeps = getDefaultDeps()) {
  return async function getAuthContext(req: Request): Promise<AuthContext | null> {
    const bearer = readBearerHeader(req)

    if (bearer.present) {
      if (!bearer.token) return null

      let verified: VerifiedToken
      try {
        verified = await deps.verifyJwt(bearer.token)
      } catch {
        return null
      }

      const identity = await deps.findUserById(verified.sub)
      return identity ? jwtContext(identity, verified) : null
    }

    return deps.sessionContext(req)
  }
}

export const getAuthContext = makeGetAuthContext()

type ContextResolver = (req: Request) => Promise<AuthContext | null>

function unauthorized(res: Response): void {
  res.status(401).json({
    success: false,
    message: "You must be signed in to access this resource.",
  })
}

export function makeRequireAuth(resolve: ContextResolver = getAuthContext): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const auth = await resolve(req)

    if (!auth) {
      unauthorized(res)
      return
    }

    req.auth = auth
    next()
  }
}

export const requireAuth = makeRequireAuth()

/**
 * Role gate that always runs authentication first. Applied after
 * `requireAuth` it reuses the context, otherwise it verifies the session.
 */
export function makeRequireRole(
  roles: readonly UserRole[],
  resolve: ContextResolver = getAuthContext,
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth) {
      const auth = await resolve(req)
      if (!auth) {
        unauthorized(res)
        return
      }
      req.auth = auth
    }

    if (!roles.includes(req.auth.user.role)) {
      res.status(403).json({
        success: false,
        message: "You do not have permission to access this resource.",
      })
      return
    }

    next()
  }
}

export function requireRole(...roles: UserRole[]): RequestHandler {
  return makeRequireRole(roles)
}

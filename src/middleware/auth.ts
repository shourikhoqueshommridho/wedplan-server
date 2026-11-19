import type { NextFunction, Request, RequestHandler, Response } from "express"
import { fromNodeHeaders } from "better-auth/node"

import { getAuth } from "../lib/auth.js"
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
  if (typeof value === "string") {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
  }
  return null
}

/**
 * Validates the Better Auth session cookie against the database. The user and
 * role are derived here from the verified session — never from request input.
 */
export async function getAuthContext(req: Request): Promise<AuthContext | null> {
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

export const requireAuth: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const auth = await getAuthContext(req)

  if (!auth) {
    res.status(401).json({
      success: false,
      message: "You must be signed in to access this resource.",
    })
    return
  }

  req.auth = auth
  next()
}

/**
 * Role gate that always runs authentication first. Applied after
 * `requireAuth` it reuses the context, otherwise it verifies the session.
 */
export function requireRole(...roles: UserRole[]): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth) {
      const auth = await getAuthContext(req)
      if (!auth) {
        res.status(401).json({
          success: false,
          message: "You must be signed in to access this resource.",
        })
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

import type { RequestHandler } from "express"
import { ObjectId, type Filter } from "mongodb"

import { checkoutDiagFor, safeErrorInfo } from "../lib/checkout-diagnostics.js"
import { getDb } from "../lib/mongodb.js"
import { isBlockedUser } from "../services/subscriptions.service.js"

export interface BlockableUserDocument {
  _id: ObjectId | string
  blocked?: boolean
  isBlocked?: boolean
  banned?: boolean
  suspended?: boolean
  status?: string
  accountStatus?: string
}

function userIdFilter(userId: string): Filter<BlockableUserDocument> {
  return /^[a-f\d]{24}$/i.test(userId)
    ? { $or: [{ _id: new ObjectId(userId) }, { _id: userId }] }
    : { _id: userId }
}

export interface ActiveUserDeps {
  findUser(userId: string): Promise<BlockableUserDocument | null>
}

const defaultDeps: ActiveUserDeps = {
  findUser: async (userId) => {
    const db = await getDb()
    return db.collection<BlockableUserDocument>("users").findOne(userIdFilter(userId), {
      projection: {
        blocked: 1,
        isBlocked: 1,
        banned: 1,
        suspended: 1,
        status: 1,
        accountStatus: 1,
      },
    })
  },
}

/**
 * Account-level gate for protected routes. Identity always comes from the
 * verified auth context (`req.auth`), never from the request body.
 */
export function makeRequireActiveUser(deps: ActiveUserDeps = defaultDeps): RequestHandler {
  return async (req, res, next) => {
    try {
      checkoutDiagFor(res, "blocked-gate-db-start")
      const user = await deps.findUser(req.auth!.user.id)
      checkoutDiagFor(res, "blocked-gate-lookup-done", { found: user !== null })

      if (isBlockedUser(user)) {
        res.status(403).json({
          success: false,
          message: "This account is blocked and cannot access WedPlan features.",
        })
        return
      }

      next()
    } catch (error) {
      const info = safeErrorInfo(error)
      checkoutDiagFor(res, "blocked-gate-error", {
        errorName: info.errorName,
        errorCode: info.errorCode,
      })
      next(error)
    }
  }
}

export const requireActiveUser = makeRequireActiveUser()

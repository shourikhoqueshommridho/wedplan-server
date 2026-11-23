import type { RequestHandler } from "express"
import { ObjectId, type Filter } from "mongodb"

import { checkoutDiagFor, safeErrorInfo } from "../lib/checkout-diagnostics.js"
import { getDb } from "../lib/mongodb.js"
import { isBlockedUser } from "../services/subscriptions.service.js"

interface BlockableUserDocument {
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

/**
 * Account-level gate for billing endpoints. Vendor identity always comes from
 * the verified Better Auth session (`req.auth`), never from the request body.
 */
export const requireActiveUser: RequestHandler = async (req, res, next) => {
  try {
    checkoutDiagFor(res, "blocked-gate-db-start")
    const db = await getDb()
    checkoutDiagFor(res, "blocked-gate-db-ready")
    const user = await db.collection<BlockableUserDocument>("users").findOne(
      userIdFilter(req.auth!.user.id),
      {
        projection: {
          blocked: 1,
          isBlocked: 1,
          banned: 1,
          suspended: 1,
          status: 1,
          accountStatus: 1,
        },
      },
    )
    checkoutDiagFor(res, "blocked-gate-lookup-done", { found: user !== null })

    if (isBlockedUser(user)) {
      res.status(403).json({
        success: false,
        message: "This account is blocked and cannot manage a subscription.",
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

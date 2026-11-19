import { Router } from "express"
import rateLimit from "express-rate-limit"
import { ObjectId, type Filter } from "mongodb"
import { fromNodeHeaders } from "better-auth/node"

import { getAuth } from "../lib/auth.js"
import { getDb } from "../lib/mongodb.js"
import {
  createVendorIntentToken,
  VENDOR_INTENT_COOKIE,
  vendorIntentCookieOptions,
} from "../lib/vendor-intent.js"
import { requireAuth, requireRole } from "../middleware/auth.js"
import { upsertVendorProfile } from "../services/vendors.service.js"
import { normalizeUserRole } from "../types/auth.js"
import {
  vendorBusinessDetailsSchema,
  vendorRegistrationSchema,
} from "../validators/vendor.js"

const accountRouter = Router()

const registrationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many attempts. Please wait a few minutes and try again.",
  },
})

function firstIssueMessage(error: { issues: { message: string }[] }): string {
  return error.issues[0]?.message ?? "Please check the submitted details."
}

async function findUserIdByEmail(email: string): Promise<string | null> {
  const db = await getDb()
  const user = await db.collection("users").findOne(
    { email },
    { projection: { _id: 1 } },
  )

  return user ? String(user._id) : null
}

interface AuthUserDocument {
  _id: ObjectId | string
  role?: string
  updatedAt?: Date
}

function userIdFilter(userId: string): Filter<AuthUserDocument> {
  return /^[a-f\d]{24}$/i.test(userId)
    ? { $or: [{ _id: new ObjectId(userId) }, { _id: userId }] }
    : { _id: userId }
}

/**
 * POST /api/account/vendor/register
 * Public vendor registration. The Better Auth sign-up is performed by this
 * server so the trusted role assignment and business profile happen before a
 * session is handed to the browser.
 */
accountRouter.post(
  "/vendor/register",
  registrationLimiter,
  async (req, res, next) => {
    const parsed = vendorRegistrationSchema.safeParse(req.body)

    if (!parsed.success) {
      res.status(400).json({
        success: false,
        message: firstIssueMessage(parsed.error),
        errors: parsed.error.issues.map((issue) => ({
          field: issue.path.map(String).join("."),
          message: issue.message,
        })),
      })
      return
    }

    const input = parsed.data

    try {
      if (await findUserIdByEmail(input.email)) {
        res.status(409).json({
          success: false,
          message: "An account with this email already exists. Please sign in instead.",
          errors: [{ field: "email", message: "This email is already registered." }],
        })
        return
      }

      const auth = await getAuth()
      const upstream = await auth.api.signUpEmail({
        body: {
          name: input.name,
          email: input.email,
          password: input.password,
          ...(input.image ? { image: input.image } : {}),
        },
        headers: fromNodeHeaders(req.headers),
        asResponse: true,
      })

      if (!upstream.ok) {
        let upstreamMessage = ""

        try {
          const payload = (await upstream.json()) as { message?: unknown }
          upstreamMessage = typeof payload.message === "string" ? payload.message : ""
        } catch {
          upstreamMessage = ""
        }

        if (/already exists/i.test(upstreamMessage)) {
          res.status(409).json({
            success: false,
            message: "An account with this email already exists. Please sign in instead.",
            errors: [{ field: "email", message: "This email is already registered." }],
          })
          return
        }

        res.status(upstream.status === 422 ? 400 : upstream.status).json({
          success: false,
          message: upstreamMessage || "The vendor account could not be created.",
        })
        return
      }

      const payload = (await upstream.json()) as {
        user?: { id?: unknown; name?: unknown; email?: unknown }
      }

      const userId = typeof payload.user?.id === "string" ? payload.user.id : ""
      const userEmail = typeof payload.user?.email === "string" ? payload.user.email : input.email
      const userName = typeof payload.user?.name === "string" ? payload.user.name : input.name

      if (!userId) {
        res.status(500).json({
          success: false,
          message: "The vendor account was created but its identity could not be verified.",
        })
        return
      }

      const db = await getDb()
      const roleUpdate = await db
        .collection<AuthUserDocument>("users")
        .updateOne(userIdFilter(userId), {
          $set: { role: "vendor", updatedAt: new Date() },
        })

      if (roleUpdate.matchedCount === 0) {
        console.error("[wedplan-api] Vendor role update matched no user", userId)
        res.status(500).json({
          success: false,
          message: "The vendor account was created but its role could not be assigned.",
        })
        return
      }

      const profile = await upsertVendorProfile(userId, userEmail, {
        businessName: input.businessName,
        category: input.category,
        phone: input.phone,
        location: input.location,
        website: input.website ?? null,
        description: input.description,
      })

      for (const cookie of upstream.headers.getSetCookie()) {
        res.append("set-cookie", cookie)
      }

      res.status(201).json({
        success: true,
        data: {
          user: {
            id: userId,
            name: userName,
            email: userEmail,
            role: "vendor",
          },
          profile,
        },
      })
    } catch (error) {
      next(error)
    }
  },
)

/**
 * POST /api/account/vendor/intent
 * Stores the vendor's business details in a short-lived signed cookie before
 * the Google OAuth redirect. The callback can only grant the vendor role while
 * this cookie verifies and only when Better Auth creates a new user.
 */
accountRouter.post("/vendor/intent", registrationLimiter, (req, res) => {
  const parsed = vendorBusinessDetailsSchema.safeParse(req.body)

  if (!parsed.success) {
    res.status(400).json({
      success: false,
      message: firstIssueMessage(parsed.error),
      errors: parsed.error.issues.map((issue) => ({
        field: issue.path.map(String).join("."),
        message: issue.message,
      })),
    })
    return
  }

  res.cookie(
    VENDOR_INTENT_COOKIE,
    createVendorIntentToken(parsed.data),
    vendorIntentCookieOptions(),
  )

  res.status(200).json({ success: true })
})

accountRouter.delete("/vendor/intent", (_req, res) => {
  res.clearCookie(VENDOR_INTENT_COOKIE, { path: "/" })
  res.status(200).json({ success: true })
})

accountRouter.get("/me", requireAuth, (req, res) => {
  res.status(200).json({
    success: true,
    data: req.auth,
  })
})

accountRouter.get("/admin/users", requireRole("admin"), async (_req, res) => {
  const db = await getDb()
  const documents = await db
    .collection("users")
    .find(
      {},
      {
        projection: {
          _id: 1,
          name: 1,
          email: 1,
          image: 1,
          role: 1,
          createdAt: 1,
        },
      },
    )
    .sort({ createdAt: -1 })
    .limit(100)
    .toArray()

  const users = documents.map((document) => ({
    id: String(document._id),
    name: typeof document.name === "string" ? document.name : "Unnamed user",
    email: typeof document.email === "string" ? document.email : "",
    image: typeof document.image === "string" ? document.image : null,
    role: normalizeUserRole(document.role),
    createdAt:
      document.createdAt instanceof Date
        ? document.createdAt.toISOString()
        : typeof document.createdAt === "string"
          ? document.createdAt
          : null,
  }))

  res.status(200).json({
    success: true,
    data: { users },
  })
})

export default accountRouter

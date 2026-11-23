import { Router } from "express"
import type { Filter, WithId } from "mongodb"
import { z } from "zod"

import { idFilter } from "../lib/object-id.js"
import { getDb } from "../lib/mongodb.js"
import { requireRole } from "../middleware/auth.js"
import { requireActiveUser } from "../middleware/blocked.js"
import {
  deleteAdminService,
  listAdminTransactions,
  setUserBlocked,
} from "../services/admin.service.js"
import { listBookings } from "../services/bookings.service.js"
import { approveService } from "../services/service-approval.service.js"
import { listVendorProfiles } from "../services/vendors.service.js"
import type { ServiceRecord } from "../types/service.js"
import { normalizeUserRole } from "../types/auth.js"
import { objectIdSchema } from "../validators/vendor.js"

const adminRouter = Router()

adminRouter.use(requireRole("admin"))
adminRouter.use(requireActiveUser)

const approvalSchema = z.object({
  status: z.enum(["approved", "rejected"], {
    message: "Choose approved or rejected.",
  }),
})

interface AdminServiceDocument extends ServiceRecord {
  updatedAt?: Date | string
}

function toIsoString(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "string") {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
  }
  return null
}

function serviceIdFilter(id: string): Filter<AdminServiceDocument> {
  return idFilter<AdminServiceDocument>(id)
}

function toAdminService(document: WithId<AdminServiceDocument>) {
  return {
    id: String(document._id),
    name: document.serviceName,
    category: document.category,
    description: document.description,
    price: document.price,
    location: document.location,
    images: document.images,
    vendorId: document.vendorId,
    vendorName: document.vendorName,
    status: document.status,
    isActive: document.isActive,
    createdAt: toIsoString(document.createdAt),
    updatedAt: toIsoString(document.updatedAt),
  }
}

adminRouter.get("/users", async (_req, res, next) => {
  try {
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
            blocked: 1,
            blockedAt: 1,
          },
        },
      )
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray()

    const users = documents.map((document) => ({
      id: String(document._id),
      name: typeof document.name === "string" ? document.name : "Unnamed user",
      email: typeof document.email === "string" ? document.email : "",
      image: typeof document.image === "string" ? document.image : null,
      role: normalizeUserRole(document.role),
      createdAt: toIsoString(document.createdAt),
      blocked: document.blocked === true,
      blockedAt: toIsoString(document.blockedAt),
    }))

    res.status(200).json({ success: true, data: { users } })
  } catch (error) {
    next(error)
  }
})

adminRouter.get("/vendors", async (_req, res, next) => {
  try {
    const vendors = await listVendorProfiles(200)
    res.status(200).json({ success: true, data: { vendors } })
  } catch (error) {
    next(error)
  }
})

adminRouter.get("/services", async (_req, res, next) => {
  try {
    const db = await getDb()
    const documents = await db
      .collection<AdminServiceDocument>("services")
      .find({})
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray()

    res.status(200).json({
      success: true,
      data: { services: documents.map(toAdminService) },
    })
  } catch (error) {
    next(error)
  }
})

adminRouter.patch("/services/:id/approval", async (req, res, next) => {
  const parsedId = objectIdSchema.safeParse(req.params.id)
  const parsedBody = approvalSchema.safeParse(req.body)

  if (!parsedId.success) {
    res.status(400).json({ success: false, message: "Invalid service ID." })
    return
  }

  if (!parsedBody.success) {
    res.status(400).json({
      success: false,
      message: parsedBody.error.issues[0]?.message ?? "Choose a valid approval status.",
    })
    return
  }

  try {
    const result = await approveService(parsedId.data, parsedBody.data.status)

    if (!result.ok) {
      if (result.reason === "not_found") {
        res.status(404).json({ success: false, message: "Service not found." })
        return
      }

      const { plan, activeCount, limit } = result.quota
      res.status(403).json({
        success: false,
        message:
          "This vendor has reached the Free Plan limit of 3 active services. " +
          "Remove an active service or upgrade the vendor to Premium before approving another.",
        data: { plan, activeCount, limit },
      })
      return
    }

    res.status(200).json({
      success: true,
      data: { message: `Service ${parsedBody.data.status}.` },
    })
  } catch (error) {
    next(error)
  }
})

adminRouter.patch("/users/:id/block", async (req, res, next) => {
  const parsedId = z.string().min(1).safeParse(req.params.id)
  const parsedBody = z
    .object({ reason: z.string().trim().max(300).optional() })
    .safeParse(req.body ?? {})

  if (!parsedId.success) {
    res.status(400).json({ success: false, message: "Invalid user ID." })
    return
  }
  if (!parsedBody.success) {
    res.status(400).json({ success: false, message: "A valid reason is required." })
    return
  }

  try {
    const result = await setUserBlocked(
      parsedId.data,
      true,
      req.auth!.user.id,
      parsedBody.data.reason ?? null,
    )

    if (!result.ok) {
      const status = result.reason === "self" ? 400 : 404
      res.status(status).json({
        success: false,
        message:
          result.reason === "self"
            ? "You cannot block your own account."
            : "User not found.",
      })
      return
    }

    res.status(200).json({ success: true, data: { message: "User blocked." } })
  } catch (error) {
    next(error)
  }
})

adminRouter.patch("/users/:id/unblock", async (req, res, next) => {
  const parsedId = z.string().min(1).safeParse(req.params.id)

  if (!parsedId.success) {
    res.status(400).json({ success: false, message: "Invalid user ID." })
    return
  }

  try {
    const result = await setUserBlocked(parsedId.data, false, req.auth!.user.id, null)
    if (!result.ok) {
      res.status(404).json({ success: false, message: "User not found." })
      return
    }

    res.status(200).json({ success: true, data: { message: "User unblocked." } })
  } catch (error) {
    next(error)
  }
})

adminRouter.get("/transactions", async (_req, res, next) => {
  try {
    const transactions = await listAdminTransactions(100)
    res.status(200).json({ success: true, data: { transactions } })
  } catch (error) {
    next(error)
  }
})

adminRouter.delete("/services/:id", async (req, res, next) => {
  const parsedId = objectIdSchema.safeParse(req.params.id)

  if (!parsedId.success) {
    res.status(400).json({ success: false, message: "Invalid service ID." })
    return
  }

  try {
    const result = await deleteAdminService(parsedId.data)
    if (!result.ok) {
      res.status(404).json({ success: false, message: "Service not found." })
      return
    }

    res.status(200).json({ success: true, data: { message: "Service deleted." } })
  } catch (error) {
    next(error)
  }
})

adminRouter.get("/bookings", async (_req, res, next) => {
  try {
    const bookings = await listBookings({})
    res.status(200).json({ success: true, data: { bookings } })
  } catch (error) {
    next(error)
  }
})

export default adminRouter

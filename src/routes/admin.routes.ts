import { Router } from "express"
import { ObjectId, type Filter, type WithId } from "mongodb"
import { z } from "zod"

import { getDb } from "../lib/mongodb.js"
import { requireRole } from "../middleware/auth.js"
import { listBookings } from "../services/bookings.service.js"
import { approveService } from "../services/service-approval.service.js"
import { listVendorProfiles } from "../services/vendors.service.js"
import type { ServiceRecord } from "../types/service.js"
import { normalizeUserRole } from "../types/auth.js"
import { objectIdSchema } from "../validators/vendor.js"

const adminRouter = Router()

adminRouter.use(requireRole("admin"))

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
  return { $or: [{ _id: id }, { _id: new ObjectId(id) }] } as Filter<AdminServiceDocument>
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

adminRouter.get("/bookings", async (_req, res, next) => {
  try {
    const bookings = await listBookings({})
    res.status(200).json({ success: true, data: { bookings } })
  } catch (error) {
    next(error)
  }
})

export default adminRouter

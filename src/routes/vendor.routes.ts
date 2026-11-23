import { Router } from "express"
import type { Filter, WithId } from "mongodb"

import { idFilter } from "../lib/object-id.js"
import { getDb } from "../lib/mongodb.js"
import { escapeRegExp } from "../lib/regex.js"
import { requireRole } from "../middleware/auth.js"
import { requireActiveUser } from "../middleware/blocked.js"
import { withQuotaGuard } from "../services/service-quota.service.js"
import { getVendorProfile, upsertVendorProfile } from "../services/vendors.service.js"
import type { ServiceRecord } from "../types/service.js"
import {
  objectIdSchema,
  vendorProfileUpdateSchema,
  vendorServiceSchema,
  vendorServiceUpdateSchema,
} from "../validators/vendor.js"
import { serviceQuerySchema } from "../validators/service-query.js"

const vendorRouter = Router()

vendorRouter.use(requireRole("vendor"))
vendorRouter.use(requireActiveUser)

interface VendorServiceDocument extends ServiceRecord {
  updatedAt?: Date | string
}

function firstIssueMessage(error: { issues: { message: string }[] }): string {
  return error.issues[0]?.message ?? "Please check the submitted details."
}

function toIsoString(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "string") {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
  }
  return null
}

function serviceIdFilter(id: string): Filter<VendorServiceDocument> {
  return idFilter<VendorServiceDocument>(id)
}

function toVendorService(document: WithId<VendorServiceDocument>) {
  return {
    id: String(document._id),
    name: document.serviceName,
    category: document.category,
    description: document.description,
    price: document.price,
    location: document.location,
    images: document.images,
    status: document.status,
    isActive: document.isActive,
    createdAt: toIsoString(document.createdAt),
    updatedAt: toIsoString(document.updatedAt),
  }
}

vendorRouter.get("/profile", async (req, res) => {
  const profile = await getVendorProfile(req.auth!.user.id)

  res.status(200).json({
    success: true,
    data: { profile },
  })
})

vendorRouter.put("/profile", async (req, res, next) => {
  const parsed = vendorProfileUpdateSchema.safeParse(req.body)

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

  try {
    const profile = await upsertVendorProfile(
      req.auth!.user.id,
      req.auth!.user.email,
      parsed.data,
    )

    res.status(200).json({ success: true, data: { profile } })
  } catch (error) {
    next(error)
  }
})

vendorRouter.get("/services", async (req, res, next) => {
  try {
    const query = serviceQuerySchema.safeParse(req.query)
    if (!query.success) {
      res.status(400).json({
        success: false,
        message: "Invalid query parameters.",
        errors: query.error.issues.map((issue) => ({
          field: issue.path.map(String).join("."),
          message: issue.message,
        })),
      })
      return
    }

    const db = await getDb()
    const filter: Filter<VendorServiceDocument> = { vendorId: req.auth!.user.id }

    if (query.data.search) {
      filter.serviceName = { $regex: escapeRegExp(query.data.search), $options: "i" }
    }
    if (query.data.category) {
      filter.category = query.data.category
    }
    if (query.data.status) {
      filter.status = query.data.status
    }

    const documents = await db
      .collection<VendorServiceDocument>("services")
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray()

    res.status(200).json({
      success: true,
      data: { services: documents.map(toVendorService) },
    })
  } catch (error) {
    next(error)
  }
})

vendorRouter.post("/services", async (req, res, next) => {
  const parsed = vendorServiceSchema.safeParse(req.body)

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

  try {
    const db = await getDb()
    const collection = db.collection<VendorServiceDocument>("services")

    // The quota check, insert and post-write verification share one per-vendor
    // lock with admin approvals and reactivations, so concurrent submissions
    // cannot each see "2 active" and all pass the three-service limit.
    const result = await withQuotaGuard(
      req.auth!.user.id,
      async () => {
        const profile = await getVendorProfile(req.auth!.user.id)
        const now = new Date()
        const document: VendorServiceDocument = {
          serviceName: parsed.data.serviceName,
          category: parsed.data.category,
          description: parsed.data.description,
          price: parsed.data.price,
          location: parsed.data.location,
          images: parsed.data.images,
          vendorId: req.auth!.user.id,
          vendorName: profile?.businessName ?? req.auth!.user.name,
          vendorImage: req.auth!.user.image,
          status: "pending",
          isActive: true,
          createdAt: now,
          updatedAt: now,
        }
        const inserted = await collection.insertOne(document)
        return toVendorService({ ...document, _id: inserted.insertedId })
      },
      async (service) => {
        // Compensating delete: only the just-created service is removed.
        await collection.deleteOne(serviceIdFilter(service.id))
      },
    )

    if (!result.ok) {
      res.status(403).json({
        success: false,
        message:
          "Free plan allows a maximum of 3 active services. Upgrade to Premium to add more.",
        data: {
          plan: result.quota.plan,
          activeServices: result.quota.activeCount,
          limit: result.quota.limit,
        },
      })
      return
    }

    res.status(201).json({
      success: true,
      data: {
        service: result.value,
        message: "Service submitted for approval.",
      },
    })
  } catch (error) {
    next(error)
  }
})

vendorRouter.patch("/services/:id", async (req, res, next) => {
  const parsedId = objectIdSchema.safeParse(req.params.id)
  const parsedBody = vendorServiceUpdateSchema.safeParse(req.body)

  if (!parsedId.success) {
    res.status(400).json({ success: false, message: "Invalid service ID." })
    return
  }

  if (!parsedBody.success) {
    res.status(400).json({
      success: false,
      message: firstIssueMessage(parsedBody.error),
      errors: parsedBody.error.issues.map((issue) => ({
        field: issue.path.map(String).join("."),
        message: issue.message,
      })),
    })
    return
  }

  try {
    const db = await getDb()
    const collection = db.collection<VendorServiceDocument>("services")
    const filter: Filter<VendorServiceDocument> = {
      $and: [serviceIdFilter(parsedId.data), { vendorId: req.auth!.user.id }],
    }

    const existing = await collection.findOne(filter)
    if (!existing) {
      res.status(404).json({ success: false, message: "Service not found." })
      return
    }

    const updateData = parsedBody.data
    const contentFieldsChanged =
      "serviceName" in updateData ||
      "category" in updateData ||
      "description" in updateData ||
      "price" in updateData ||
      "location" in updateData ||
      "images" in updateData

    const updateSet: Record<string, unknown> = {
      ...updateData,
      updatedAt: new Date(),
    }

    const isInactive = existing.status === "inactive" || !existing.isActive
    const willActivate = isInactive && (contentFieldsChanged || updateData.isActive === true)

    if (contentFieldsChanged) {
      // Any content edit must go back through admin review before going public.
      updateSet.status = "pending"
      updateSet.isActive = true
    } else if (updateData.isActive === true && isInactive) {
      // Reactivating a delisted service is a fresh submission, not a bypass of
      // moderation: it re-enters the queue as pending.
      updateSet.status = "pending"
      updateSet.isActive = true
    } else if (updateData.isActive === false) {
      updateSet.status = "inactive"
      updateSet.isActive = false
    }

    const applyUpdate = async (): Promise<boolean> => {
      const result = await collection.updateOne(filter, { $set: updateSet })
      return result.matchedCount > 0
    }

    let matched: boolean
    if (willActivate) {
      // Reactivation consumes a free-plan slot and shares the lock with
      // creation and admin approval; the post-check reverts if it loses.
      const guard = await withQuotaGuard(
        req.auth!.user.id,
        applyUpdate,
        async () => {
          await collection.updateOne(filter, {
            $set: {
              status: existing.status,
              isActive: existing.isActive,
              updatedAt: new Date(),
            },
          })
        },
      )

      if (!guard.ok) {
        res.status(403).json({
          success: false,
          message:
            "Free plan allows a maximum of 3 active services. Upgrade to Premium to reactivate this service.",
          data: {
            plan: guard.quota.plan,
            activeServices: guard.quota.activeCount,
            limit: guard.quota.limit,
          },
        })
        return
      }
      matched = guard.value
    } else {
      matched = await applyUpdate()
    }

    if (!matched) {
      res.status(404).json({ success: false, message: "Service not found." })
      return
    }

    const document = await collection.findOne(filter)

    res.status(200).json({
      success: true,
      data: {
        service: document ? toVendorService(document) : null,
        message: contentFieldsChanged
          ? "Service updated and sent for approval."
          : "Service updated.",
      },
    })
  } catch (error) {
    next(error)
  }
})

vendorRouter.delete("/services/:id", async (req, res, next) => {
  const parsedId = objectIdSchema.safeParse(req.params.id)

  if (!parsedId.success) {
    res.status(400).json({ success: false, message: "Invalid service ID." })
    return
  }

  try {
    const db = await getDb()
    const result = await db.collection<VendorServiceDocument>("services").updateOne(
      {
        $and: [serviceIdFilter(parsedId.data), { vendorId: req.auth!.user.id }],
      },
      {
        $set: {
          isActive: false,
          status: "inactive",
          updatedAt: new Date(),
        },
      },
    )

    if (result.matchedCount === 0) {
      res.status(404).json({ success: false, message: "Service not found." })
      return
    }

    res.status(200).json({ success: true, data: { message: "Service removed from the listing." } })
  } catch (error) {
    next(error)
  }
})

export default vendorRouter

import { Router } from "express"
import { ObjectId, type Filter, type WithId } from "mongodb"

import { getDb } from "../lib/mongodb.js"
import { requireRole } from "../middleware/auth.js"
import { getVendorProfile, upsertVendorProfile } from "../services/vendors.service.js"
import type { ServiceRecord } from "../types/service.js"
import {
  objectIdSchema,
  vendorProfileUpdateSchema,
  vendorServiceSchema,
} from "../validators/vendor.js"

const vendorRouter = Router()

vendorRouter.use(requireRole("vendor"))

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
  return { $or: [{ _id: id }, { _id: new ObjectId(id) }] } as Filter<VendorServiceDocument>
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
    const db = await getDb()
    const documents = await db
      .collection<VendorServiceDocument>("services")
      .find({ vendorId: req.auth!.user.id })
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

    const db = await getDb()
    const result = await db.collection<VendorServiceDocument>("services").insertOne(document)

    res.status(201).json({
      success: true,
      data: {
        service: toVendorService({ ...document, _id: result.insertedId }),
        message: "Service submitted for approval.",
      },
    })
  } catch (error) {
    next(error)
  }
})

vendorRouter.patch("/services/:id", async (req, res, next) => {
  const parsedId = objectIdSchema.safeParse(req.params.id)
  const parsedBody = vendorServiceSchema.safeParse(req.body)

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

    const result = await collection.updateOne(filter, {
      $set: {
        ...parsedBody.data,
        status: "pending",
        isActive: true,
        updatedAt: new Date(),
      },
    })

    if (result.matchedCount === 0) {
      res.status(404).json({ success: false, message: "Service not found." })
      return
    }

    const document = await collection.findOne(filter)

    res.status(200).json({
      success: true,
      data: {
        service: document ? toVendorService(document) : null,
        message: "Service updated and sent for approval.",
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

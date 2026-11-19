import { ObjectId, type Collection } from "mongodb"

import { getDb } from "../lib/mongodb.js"
import type {
  VendorBusinessDetails,
  VendorProfile,
  VendorProfileRecord,
} from "../types/vendor.js"

export const VENDOR_PROFILE_COLLECTION = "vendor_profiles"

let indexPromise: Promise<string> | null = null

async function getCollection(): Promise<Collection<VendorProfileRecord>> {
  const collection = (await getDb()).collection<VendorProfileRecord>(VENDOR_PROFILE_COLLECTION)

  indexPromise ??= collection
    .createIndex({ userId: 1 }, { unique: true, name: "vendor_user_unique" })
    .catch((error: unknown) => {
      indexPromise = null
      console.error(
        "[wedplan-api] Could not ensure the vendor profile index:",
        error instanceof Error ? error.message : "unknown error",
      )
      return "index-failed"
    })

  await indexPromise
  return collection
}

function toIsoString(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "string") {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
  }
  return null
}

function toVendorProfile(document: VendorProfileRecord): VendorProfile {
  return {
    id: document._id instanceof ObjectId ? document._id.toHexString() : String(document._id ?? ""),
    userId: document.userId,
    businessName: document.businessName,
    category: document.category,
    phone: document.phone,
    location: document.location,
    website: document.website ?? null,
    description: document.description,
    contactEmail: document.contactEmail,
    createdAt: toIsoString(document.createdAt),
    updatedAt: toIsoString(document.updatedAt),
  }
}

export async function getVendorProfile(userId: string): Promise<VendorProfile | null> {
  const collection = await getCollection()
  const document = await collection.findOne({ userId })
  return document ? toVendorProfile(document) : null
}

export async function upsertVendorProfile(
  userId: string,
  contactEmail: string,
  details: VendorBusinessDetails,
): Promise<VendorProfile> {
  const collection = await getCollection()
  const now = new Date()

  await collection.updateOne(
    { userId },
    {
      $set: {
        businessName: details.businessName,
        category: details.category,
        phone: details.phone,
        location: details.location,
        website: details.website ?? null,
        description: details.description,
        contactEmail,
        updatedAt: now,
      },
      $setOnInsert: {
        userId,
        createdAt: now,
      },
    },
    { upsert: true },
  )

  const document = await collection.findOne({ userId })

  if (!document) {
    throw new Error("Vendor profile could not be saved.")
  }

  return toVendorProfile(document)
}

export async function listVendorProfiles(limit = 100): Promise<VendorProfile[]> {
  const collection = await getCollection()
  const documents = await collection.find({}).sort({ createdAt: -1 }).limit(limit).toArray()
  return documents.map(toVendorProfile)
}

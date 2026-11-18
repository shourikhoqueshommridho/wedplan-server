import { ObjectId, type Filter, type WithId } from "mongodb"

import { getDb } from "../lib/mongodb.js"
import type {
  PublicService,
  PublicServiceList,
  ServiceQuery,
  ServiceRecord,
} from "../types/service.js"

const SERVICE_COLLECTION = "services"

const PUBLIC_FILTER: Filter<ServiceRecord> = {
  status: "approved",
  isActive: true,
}

/**
 * The stored `category` values are human-readable labels. The Browse Services
 * UI filters with stable slugs, so the API accepts either form and always
 * returns a slug plus the original label.
 */
const CATEGORY_LABELS_BY_SLUG = {
  "photography-videography": "Photography & Videography",
  "wedding-venues": "Wedding Venues",
  "decoration-florist": "Decoration & Florist",
  "catering-services": "Catering Services",
  "makeup-styling": "Makeup & Styling",
  "wedding-fashion": "Wedding Fashion",
} as const

const CATEGORY_SLUGS_BY_LABEL = new Map<string, string>(
  Object.entries(CATEGORY_LABELS_BY_SLUG).map(([slug, label]) => [label.toLowerCase(), slug]),
)

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function exactMatch(value: string): { $regex: string; $options: string } {
  return { $regex: `^${escapeRegExp(value)}$`, $options: "i" }
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "other"
  )
}

function categorySlug(label: string): string {
  return CATEGORY_SLUGS_BY_LABEL.get(label.trim().toLowerCase()) ?? slugify(label)
}

function categoryFilterValue(value: string): string {
  const normalized = value.trim().toLowerCase()

  for (const [slug, label] of Object.entries(CATEGORY_LABELS_BY_SLUG)) {
    if (slug === normalized || label.toLowerCase() === normalized) {
      return label
    }
  }

  return value.trim()
}

function readText(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function readPrice(value: unknown): number | null {
  const amount =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN

  return Number.isFinite(amount) && amount >= 0 ? amount : null
}

function readImages(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => readText(item))
      .filter((item): item is string => item !== null)
  }

  const single = readText(value)
  return single ? [single] : []
}

function readLocation(value: string): PublicService["location"] {
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)

  if (parts.length === 0) {
    return { city: value, country: "" }
  }

  if (parts.length === 1) {
    return { city: parts[0], country: "" }
  }

  return {
    city: parts.slice(0, -1).join(", "),
    country: parts[parts.length - 1],
  }
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)

  if (parts.length === 0) return "WP"
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase()
}

function toPublicService(document: WithId<ServiceRecord>): PublicService | null {
  const id = readText(String(document._id ?? ""))
  const name = readText(document.serviceName)
  const categoryLabel = readText(document.category)
  const description = readText(document.description)
  const location = readText(document.location)
  const vendorId = readText(document.vendorId)
  const vendorName = readText(document.vendorName)
  const amount = readPrice(document.price)
  const images = readImages(document.images)

  if (
    !id ||
    !name ||
    !categoryLabel ||
    !description ||
    !location ||
    !vendorId ||
    !vendorName ||
    amount === null ||
    images.length === 0
  ) {
    return null
  }

  const createdAt =
    document.createdAt instanceof Date
      ? document.createdAt.toISOString()
      : readText(document.createdAt)

  const vendorImage = readText(document.vendorImage)

  return {
    id,
    name,
    category: categorySlug(categoryLabel),
    categoryLabel,
    shortDescription: description,
    price: {
      amount,
      currency: "BDT",
      unit: "package",
    },
    location: readLocation(location),
    vendor: {
      id: vendorId,
      name: vendorName,
      initials: getInitials(vendorName),
      ...(vendorImage ? { image: vendorImage } : {}),
    },
    image: {
      src: images[0],
      alt: `${name} by ${vendorName}`,
    },
    images,
    ...(createdAt ? { createdAt } : {}),
  }
}

export async function listPublicServices(query: ServiceQuery): Promise<PublicServiceList> {
  const collection = (await getDb()).collection<ServiceRecord>(SERVICE_COLLECTION)
  const filter: Filter<ServiceRecord> = { ...PUBLIC_FILTER }

  if (query.search) {
    filter.serviceName = containsMatch(query.search)
  }

  if (query.category) {
    filter.category = exactMatch(categoryFilterValue(query.category))
  }

  if (query.location) {
    filter.location = exactMatch(query.location)
  }

  const sortDirection = query.sort === "desc" ? -1 : 1

  const [documents, locationValues] = await Promise.all([
    collection
      .find(filter)
      .sort({ price: sortDirection, _id: 1 })
      .toArray(),
    collection.distinct("location", PUBLIC_FILTER),
  ])

  const services = documents
    .map(toPublicService)
    .filter((service): service is PublicService => service !== null)

  const locations = [...new Set(locationValues.map((value) => readText(value)))]
    .filter((value): value is string => value !== null)
    .sort((left, right) => left.localeCompare(right))

  return {
    services,
    total: services.length,
    locations,
  }
}

/** Searches anywhere in the service name rather than requiring a full match. */
function containsMatch(value: string): { $regex: string; $options: string } {
  return { $regex: escapeRegExp(value.trim()), $options: "i" }
}

/**
 * Fetches one publicly visible service. Current sample documents store their
 * `_id` as a 24-character string, while future imports may use real ObjectIds;
 * checking both keeps the endpoint compatible without changing stored data.
 */
export async function getPublicServiceById(id: string): Promise<PublicService | null> {
  const collection = (await getDb()).collection<ServiceRecord>(SERVICE_COLLECTION)
  const objectId = new ObjectId(id)

  const filter: Filter<ServiceRecord> = {
    ...PUBLIC_FILTER,
    $or: [{ _id: id }, { _id: objectId }],
  }

  const document = await collection.findOne(filter)
  return document ? toPublicService(document) : null
}

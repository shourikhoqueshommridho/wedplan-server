import { ObjectId, type Filter, type UpdateFilter, type WithId } from "mongodb"

import { getDb } from "../lib/mongodb.js"
import {
  ACTIVE_BOOKING_STATUSES,
  type ActiveBookingStatus,
  type Booking,
  type BookingRecord,
  type BookingStatus,
} from "../types/booking.js"

export const BOOKING_COLLECTION = "bookings"

/** Unique index for active reservations; sparse so past bookings never conflict. */
export const ACTIVE_BOOKING_INDEX = {
  key: { activeBookingKey: 1 },
  name: "bookings_active_customer_service_date_unique",
  unique: true,
  sparse: true,
} as const

let bookingIndexPromise: Promise<void> | null = null

export class DuplicateActiveBookingError extends Error {
  readonly code = "DUPLICATE_ACTIVE_BOOKING"

  constructor() {
    super("An active booking already exists for this service and event date.")
    this.name = "DuplicateActiveBookingError"
  }
}

export function isDuplicateActiveBookingError(error: unknown): boolean {
  return error instanceof DuplicateActiveBookingError
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "MongoServerError" &&
    (error as { code?: number }).code === 11000
  )
}

export function isActiveBookingStatus(status: BookingStatus): status is ActiveBookingStatus {
  return (ACTIVE_BOOKING_STATUSES as readonly string[]).includes(status)
}

/**
 * JSON encoding avoids delimiter collisions between ids and dates. The same
 * key is used by the unique index and by the legacy-record pre-check.
 */
export function activeBookingKey(
  customerId: string,
  serviceId: string,
  eventDate: string,
): string {
  return JSON.stringify([customerId, serviceId, eventDate])
}

/** Ensures the sparse unique index exists before any booking is inserted. */
export async function ensureBookingIndexes(): Promise<void> {
  bookingIndexPromise ??= (async () => {
    const db = await getDb()
    await db.collection<BookingRecord>(BOOKING_COLLECTION).createIndex(
      { ...ACTIVE_BOOKING_INDEX.key },
      {
        name: ACTIVE_BOOKING_INDEX.name,
        unique: ACTIVE_BOOKING_INDEX.unique,
        sparse: ACTIVE_BOOKING_INDEX.sparse,
      },
    )
  })().catch((error: unknown) => {
    bookingIndexPromise = null
    throw error
  })

  return bookingIndexPromise
}

function toIsoString(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "string") {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
  }
  return null
}

function toBooking(document: WithId<BookingRecord>): Booking {
  return {
    id: String(document._id),
    customerId: document.customerId,
    customerName: document.customerName,
    customerEmail: document.customerEmail,
    vendorId: document.vendorId,
    vendorName: document.vendorName,
    serviceId: document.serviceId,
    serviceName: document.serviceName,
    serviceImage: document.serviceImage,
    price: document.price,
    eventDate: document.eventDate,
    eventLocation: document.eventLocation,
    message: document.message,
    status: document.status,
    paymentStatus: document.paymentStatus,
    createdAt: toIsoString(document.createdAt),
    updatedAt: toIsoString(document.updatedAt),
  }
}

export function bookingIdFilter(id: string): Filter<BookingRecord> {
  return { $or: [{ _id: id }, { _id: new ObjectId(id) }] } as Filter<BookingRecord>
}

/** Builds the atomic status update, releasing the reservation when inactive. */
export function statusUpdateFor(
  status: BookingStatus,
  now: Date = new Date(),
): UpdateFilter<BookingRecord> {
  const update: UpdateFilter<BookingRecord> = {
    $set: { status, updatedAt: now },
  }

  if (!isActiveBookingStatus(status)) {
    update.$unset = { activeBookingKey: "" }
  }

  return update
}

export async function insertBooking(record: BookingRecord): Promise<Booking> {
  await ensureBookingIndexes()
  const collection = (await getDb()).collection<BookingRecord>(BOOKING_COLLECTION)

  // Catches active duplicates written before the unique key existed. New
  // concurrent requests are still protected by the unique sparse index below.
  const legacyDuplicate = await collection.findOne({
    customerId: record.customerId,
    serviceId: record.serviceId,
    eventDate: record.eventDate,
    status: { $in: [...ACTIVE_BOOKING_STATUSES] },
  })
  if (legacyDuplicate) throw new DuplicateActiveBookingError()

  const document: BookingRecord = {
    ...record,
    activeBookingKey: activeBookingKey(record.customerId, record.serviceId, record.eventDate),
  }

  try {
    const result = await collection.insertOne(document)
    return toBooking({ ...document, _id: result.insertedId })
  } catch (error) {
    if (isDuplicateKeyError(error)) throw new DuplicateActiveBookingError()
    throw error
  }
}

export async function findBooking(id: string): Promise<Booking | null> {
  const collection = (await getDb()).collection<BookingRecord>(BOOKING_COLLECTION)
  const document = await collection.findOne(bookingIdFilter(id))
  return document ? toBooking(document) : null
}

export async function listBookings(filter: Filter<BookingRecord>): Promise<Booking[]> {
  const collection = (await getDb()).collection<BookingRecord>(BOOKING_COLLECTION)
  const documents = await collection
    .find(filter)
    .sort({ createdAt: -1 })
    .limit(200)
    .toArray()

  return documents.map(toBooking)
}

export async function setBookingStatus(
  id: string,
  status: BookingStatus,
): Promise<Booking | null> {
  const collection = (await getDb()).collection<BookingRecord>(BOOKING_COLLECTION)
  const result = await collection.updateOne(bookingIdFilter(id), statusUpdateFor(status))

  if (result.matchedCount === 0) return null

  return findBooking(id)
}

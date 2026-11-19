import { ObjectId, type Filter, type WithId } from "mongodb"

import { getDb } from "../lib/mongodb.js"
import type { Booking, BookingRecord, BookingStatus } from "../types/booking.js"

export const BOOKING_COLLECTION = "bookings"

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

export async function insertBooking(record: BookingRecord): Promise<Booking> {
  const collection = (await getDb()).collection<BookingRecord>(BOOKING_COLLECTION)
  const result = await collection.insertOne(record)
  return toBooking({ ...record, _id: result.insertedId })
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
  const filter = bookingIdFilter(id)
  const result = await collection.updateOne(filter, {
    $set: { status, updatedAt: new Date() },
  })

  if (result.matchedCount === 0) return null

  return findBooking(id)
}

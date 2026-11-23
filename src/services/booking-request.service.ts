import type { Booking, BookingRecord } from "../types/booking.js"
import type { CreateBookingInput } from "../validators/booking.js"
import { isVendorBlocked } from "./blocked-vendors.service.js"
import {
  DuplicateActiveBookingError,
  insertBooking,
  isDuplicateActiveBookingError,
} from "./bookings.service.js"
import { getPublicServiceById } from "./services.service.js"

/** The public-service fields needed to create a booking snapshot. */
export interface BookableService {
  id: string
  name: string
  vendor: { id: string; name: string }
  image: { src: string }
  price: { amount: number }
}

export interface BookingCustomer {
  id: string
  name: string
  email: string
}

/** Injected so the booking rules can be tested without MongoDB. */
export interface BookingRequestDeps {
  findService(serviceId: string): Promise<BookableService | null>
  isVendorBlocked(vendorId: string): Promise<boolean>
  insert(record: BookingRecord): Promise<Booking>
}

export type CreateBookingRequestResult =
  | { ok: true; booking: Booking }
  | { ok: false; reason: "service_not_found" }
  | { ok: false; reason: "self_booking" }
  | { ok: false; reason: "vendor_blocked" }
  | { ok: false; reason: "duplicate" }

const defaultDeps: BookingRequestDeps = {
  findService: getPublicServiceById,
  isVendorBlocked,
  insert: insertBooking,
}

/** A user must never book a service that belongs to their own account. */
export function isSelfBooking(customerId: string, vendorId: string): boolean {
  return customerId === vendorId
}

/** Snapshots the service and buyer details at request time, as before. */
export function buildBookingRecord(
  input: CreateBookingInput,
  customer: BookingCustomer,
  service: BookableService,
  now: Date = new Date(),
): BookingRecord {
  return {
    customerId: customer.id,
    customerName: customer.name,
    customerEmail: customer.email,
    vendorId: service.vendor.id,
    vendorName: service.vendor.name,
    serviceId: service.id,
    serviceName: service.name,
    serviceImage: service.image.src,
    price: service.price.amount,
    eventDate: input.eventDate,
    eventLocation: input.eventLocation,
    message: input.message,
    status: "pending",
    paymentStatus: "not_required",
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Applies the self-booking and duplicate-active-booking rules before writing.
 * Duplicate protection is enforced atomically by `insertBooking`'s unique
 * sparse index; this function only translates that outcome for the caller.
 */
export async function createBookingRequest(
  input: CreateBookingInput,
  customer: BookingCustomer,
  deps: BookingRequestDeps = defaultDeps,
  now: Date = new Date(),
): Promise<CreateBookingRequestResult> {
  const service = await deps.findService(input.serviceId)
  if (!service) return { ok: false, reason: "service_not_found" }
  if (isSelfBooking(customer.id, service.vendor.id)) return { ok: false, reason: "self_booking" }
  if (await deps.isVendorBlocked(service.vendor.id)) return { ok: false, reason: "vendor_blocked" }

  const record = buildBookingRecord(input, customer, service, now)

  try {
    return { ok: true, booking: await deps.insert(record) }
  } catch (error) {
    if (isDuplicateActiveBookingError(error) || error instanceof DuplicateActiveBookingError) {
      return { ok: false, reason: "duplicate" }
    }
    throw error
  }
}

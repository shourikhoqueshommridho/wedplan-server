import type { ObjectId } from "mongodb"

export const BOOKING_STATUSES = [
  "pending",
  "accepted",
  "declined",
  "cancelled",
  "completed",
] as const

export type BookingStatus = (typeof BOOKING_STATUSES)[number]

export const BOOKING_PAYMENT_STATUSES = ["not_required", "unpaid", "paid", "refunded"] as const

export type BookingPaymentStatus = (typeof BOOKING_PAYMENT_STATUSES)[number]

export interface BookingRecord {
  _id?: ObjectId
  customerId: string
  customerName: string
  customerEmail: string
  vendorId: string
  vendorName: string
  serviceId: string
  serviceName: string
  serviceImage: string | null
  price: number
  eventDate: string
  eventLocation: string
  message: string
  status: BookingStatus
  paymentStatus: BookingPaymentStatus
  createdAt: Date
  updatedAt: Date
}

export interface Booking {
  id: string
  customerId: string
  customerName: string
  customerEmail: string
  vendorId: string
  vendorName: string
  serviceId: string
  serviceName: string
  serviceImage: string | null
  price: number
  eventDate: string
  eventLocation: string
  message: string
  status: BookingStatus
  paymentStatus: BookingPaymentStatus
  createdAt: string | null
  updatedAt: string | null
}

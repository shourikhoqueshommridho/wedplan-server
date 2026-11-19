import { Router } from "express"

import { requireAuth, requireRole } from "../middleware/auth.js"
import {
  findBooking,
  insertBooking,
  listBookings,
  setBookingStatus,
} from "../services/bookings.service.js"
import { getPublicServiceById } from "../services/services.service.js"
import type { BookingRecord, BookingStatus } from "../types/booking.js"
import { createBookingSchema, updateBookingStatusSchema } from "../validators/booking.js"
import { objectIdSchema } from "../validators/vendor.js"

const bookingRouter = Router()

bookingRouter.post("/", requireRole("customer"), async (req, res, next) => {
  const parsed = createBookingSchema.safeParse(req.body)

  if (!parsed.success) {
    res.status(400).json({
      success: false,
      message: parsed.error.issues[0]?.message ?? "Please check the booking details.",
      errors: parsed.error.issues.map((issue) => ({
        field: issue.path.map(String).join("."),
        message: issue.message,
      })),
    })
    return
  }

  try {
    const service = await getPublicServiceById(parsed.data.serviceId)

    if (!service) {
      res.status(404).json({
        success: false,
        message: "This service is not available for booking.",
      })
      return
    }

    const now = new Date()
    const record: BookingRecord = {
      customerId: req.auth!.user.id,
      customerName: req.auth!.user.name,
      customerEmail: req.auth!.user.email,
      vendorId: service.vendor.id,
      vendorName: service.vendor.name,
      serviceId: service.id,
      serviceName: service.name,
      serviceImage: service.image.src,
      price: service.price.amount,
      eventDate: parsed.data.eventDate,
      eventLocation: parsed.data.eventLocation,
      message: parsed.data.message,
      status: "pending",
      paymentStatus: "not_required",
      createdAt: now,
      updatedAt: now,
    }

    const booking = await insertBooking(record)

    res.status(201).json({
      success: true,
      data: {
        booking,
        message: "Booking request sent to the vendor.",
      },
    })
  } catch (error) {
    next(error)
  }
})

bookingRouter.get("/", requireAuth, async (req, res, next) => {
  try {
    const role = req.auth!.user.role
    const userId = req.auth!.user.id
    const filter =
      role === "admin" ? {} : role === "vendor" ? { vendorId: userId } : { customerId: userId }

    const bookings = await listBookings(filter)

    res.status(200).json({
      success: true,
      data: { bookings },
    })
  } catch (error) {
    next(error)
  }
})

bookingRouter.patch("/:id/status", requireAuth, async (req, res, next) => {
  const parsedId = objectIdSchema.safeParse(req.params.id)
  const parsedBody = updateBookingStatusSchema.safeParse(req.body)

  if (!parsedId.success) {
    res.status(400).json({ success: false, message: "Invalid booking ID." })
    return
  }

  if (!parsedBody.success) {
    res.status(400).json({
      success: false,
      message: parsedBody.error.issues[0]?.message ?? "Choose a valid booking status.",
    })
    return
  }

  try {
    const booking = await findBooking(parsedId.data)

    if (!booking) {
      res.status(404).json({ success: false, message: "Booking not found." })
      return
    }

    const role = req.auth!.user.role
    const userId = req.auth!.user.id
    const nextStatus: BookingStatus = parsedBody.data.status

    if (role === "customer") {
      if (booking.customerId !== userId || nextStatus !== "cancelled") {
        res.status(403).json({
          success: false,
          message: "You can only cancel your own booking request.",
        })
        return
      }

      if (booking.status !== "pending" && booking.status !== "accepted") {
        res.status(409).json({
          success: false,
          message: "This booking can no longer be cancelled.",
        })
        return
      }
    } else if (role === "vendor") {
      if (booking.vendorId !== userId) {
        res.status(403).json({
          success: false,
          message: "You can only manage bookings for your own services.",
        })
        return
      }

      if (!["accepted", "declined", "completed"].includes(nextStatus)) {
        res.status(403).json({
          success: false,
          message: "Vendors can accept, decline or complete booking requests.",
        })
        return
      }

      const allowedTransitions: Record<BookingStatus, BookingStatus[]> = {
        pending: ["accepted", "declined"],
        accepted: ["completed"],
        declined: [],
        cancelled: [],
        completed: [],
      }

      if (!allowedTransitions[booking.status].includes(nextStatus)) {
        res.status(409).json({
          success: false,
          message: "This booking cannot move to that status.",
        })
        return
      }
    }

    const updated = await setBookingStatus(parsedId.data, nextStatus)

    res.status(200).json({ success: true, data: { booking: updated } })
  } catch (error) {
    next(error)
  }
})

export default bookingRouter

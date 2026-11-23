import { Router } from "express"

import { requireAuth, requireRole } from "../middleware/auth.js"
import { requireActiveUser } from "../middleware/blocked.js"
import { createBookingRequest } from "../services/booking-request.service.js"
import { evaluateBookingTransition } from "../services/booking-transitions.js"
import { findBooking, listBookings, setBookingStatus } from "../services/bookings.service.js"
import type { BookingStatus } from "../types/booking.js"
import { createBookingSchema, updateBookingStatusSchema } from "../validators/booking.js"
import { objectIdSchema } from "../validators/vendor.js"

const bookingRouter = Router()

bookingRouter.post("/", requireRole("customer"), requireActiveUser, async (req, res, next) => {
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
    const result = await createBookingRequest(parsed.data, {
      id: req.auth!.user.id,
      name: req.auth!.user.name,
      email: req.auth!.user.email,
    })

    if (!result.ok) {
      if (result.reason === "service_not_found") {
        res.status(404).json({
          success: false,
          message: "This service is not available for booking.",
        })
        return
      }

      if (result.reason === "self_booking") {
        res.status(403).json({
          success: false,
          message: "You cannot book your own service.",
        })
        return
      }

      if (result.reason === "vendor_blocked") {
        res.status(403).json({
          success: false,
          message: "This service is not available for booking.",
        })
        return
      }

      res.status(409).json({
        success: false,
        message: "You already have an active booking request for this service on that date.",
      })
      return
    }

    res.status(201).json({
      success: true,
      data: {
        booking: result.booking,
        message: "Booking request sent to the vendor.",
      },
    })
  } catch (error) {
    next(error)
  }
})

bookingRouter.get("/", requireAuth, requireActiveUser, async (req, res, next) => {
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

bookingRouter.patch("/:id/status", requireAuth, requireActiveUser, async (req, res, next) => {
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

    const nextStatus: BookingStatus = parsedBody.data.status
    const decision = evaluateBookingTransition(
      { customerId: booking.customerId, vendorId: booking.vendorId, status: booking.status },
      { role: req.auth!.user.role, id: req.auth!.user.id },
      nextStatus,
    )

    if (!decision.allowed) {
      res.status(decision.status).json({ success: false, message: decision.message })
      return
    }

    const updated = await setBookingStatus(parsedId.data, nextStatus)

    res.status(200).json({ success: true, data: { booking: updated } })
  } catch (error) {
    next(error)
  }
})

export default bookingRouter

import type { UserRole } from "../types/auth.js"
import type { BookingStatus } from "../types/booking.js"

export interface BookingForTransition {
  customerId: string
  vendorId: string
  status: BookingStatus
}

export interface BookingActor {
  role: UserRole
  id: string
}

export type TransitionDecision =
  | { allowed: true }
  | { allowed: false; status: 403 | 409; message: string }

/** Vendor-owned transitions only. Customers can only move pending -> cancelled. */
export const VENDOR_BOOKING_TRANSITIONS: Record<BookingStatus, readonly BookingStatus[]> = {
  pending: ["accepted", "declined"],
  accepted: ["completed"],
  declined: [],
  cancelled: [],
  completed: [],
}

function deny(status: 403 | 409, message: string): TransitionDecision {
  return { allowed: false, status, message }
}

/**
 * Single server-side state machine for POST-style booking status changes.
 * 403 means the actor/action is not permitted, 409 means the current booking
 * state cannot make that move. Unknown and admin roles have no transition
 * rights; admins keep their read/moderation tools in `/api/admin`.
 */
export function evaluateBookingTransition(
  booking: BookingForTransition,
  actor: BookingActor,
  nextStatus: BookingStatus,
): TransitionDecision {
  if (actor.role === "customer") {
    if (booking.customerId !== actor.id || nextStatus !== "cancelled") {
      return deny(403, "You can only cancel your own booking request.")
    }

    if (booking.status !== "pending") {
      return deny(409, "This booking can no longer be cancelled.")
    }

    return { allowed: true }
  }

  if (actor.role === "vendor") {
    if (booking.vendorId !== actor.id) {
      return deny(403, "You can only manage bookings for your own services.")
    }

    if (!["accepted", "declined", "completed"].includes(nextStatus)) {
      return deny(403, "Vendors can accept, decline or complete booking requests.")
    }

    if (!VENDOR_BOOKING_TRANSITIONS[booking.status].includes(nextStatus)) {
      return deny(409, "This booking cannot move to that status.")
    }

    return { allowed: true }
  }

  return deny(403, "You do not have permission to change booking statuses.")
}

import { z } from "zod"

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

export const createBookingSchema = z.object({
  serviceId: z
    .string()
    .trim()
    .regex(/^[a-f\d]{24}$/i, "Invalid service ID."),
  eventDate: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a valid event date.")
    .refine((value) => value >= todayUtc(), "The event date cannot be in the past."),
  eventLocation: z
    .string()
    .trim()
    .min(2, "Enter the event location.")
    .max(180, "Location must be 180 characters or fewer."),
  message: z
    .string()
    .trim()
    .max(1000, "Message must be 1,000 characters or fewer.")
    .optional()
    .default(""),
})

export const updateBookingStatusSchema = z.object({
  status: z.enum(["accepted", "declined", "cancelled", "completed"], {
    message: "Choose a valid booking status.",
  }),
})

export type CreateBookingInput = z.infer<typeof createBookingSchema>

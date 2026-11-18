import { z } from "zod"

/**
 * Express query values can be strings, arrays, or nested objects. Requiring
 * plain strings here means repeated or object-shaped parameters are rejected
 * with a 400 instead of being silently coerced.
 */
export const serviceQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  category: z.string().trim().max(80).optional(),
  location: z.string().trim().max(160).optional(),
  sort: z.enum(["asc", "desc"]).optional(),
})

export const serviceIdSchema = z
  .string()
  .trim()
  .regex(/^[a-f\d]{24}$/i, "Invalid service ID.")

export type ServiceQueryInput = z.infer<typeof serviceQuerySchema>

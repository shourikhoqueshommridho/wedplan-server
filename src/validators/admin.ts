import { z } from "zod"

/** Query values arrive as strings/arrays; strict coercion yields 400 on abuse. */
export const adminUsersQuerySchema = z.object({
  search: z.string().trim().max(120).optional().default(""),
  role: z.enum(["all", "customer", "vendor", "admin"]).optional().default("all"),
  status: z.enum(["all", "active", "blocked"]).optional().default("all"),
  page: z.coerce.number().int().min(1).max(100_000).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
})

export type AdminUsersQueryInput = z.infer<typeof adminUsersQuerySchema>

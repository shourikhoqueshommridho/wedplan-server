import type { Document, Filter } from "mongodb"

import { getDb } from "../lib/mongodb.js"
import type { PaymentTransactionRecord } from "../types/subscription.js"
import { BLOCKED_USER_FILTER } from "./blocked-vendors.service.js"

/** Only statuses the Stripe webhook writes for completed payments count as revenue. */
export const SUCCESSFUL_TRANSACTION_STATUSES = ["paid"] as const

export interface RevenueByCurrency {
  currency: string
  amount: number
}

export interface AdminOverview {
  totalUsers: number
  totalCustomers: number
  totalVendors: number
  blockedUsers: number
  totalServices: number
  pendingServices: number
  approvedActiveServices: number
  totalBookings: number
  pendingBookings: number
  completedBookings: number
  totalTransactions: number
  successfulTransactions: number
  revenueByCurrency: RevenueByCurrency[]
}

interface RevenueAggregateRow {
  _id: string | null
  amount: number
}

/** Injected so counts and aggregation can be verified without a database. */
export interface AdminOverviewDeps {
  countUsers(filter: Filter<Document>): Promise<number>
  countServices(filter: Filter<Document>): Promise<number>
  countBookings(filter: Filter<Document>): Promise<number>
  countTransactions(filter: Filter<Document>): Promise<number>
  aggregateRevenue(): Promise<RevenueAggregateRow[]>
}

const defaultDeps: AdminOverviewDeps = {
  countUsers: async (filter) => {
    const db = await getDb()
    return db.collection("users").countDocuments(filter)
  },
  countServices: async (filter) => {
    const db = await getDb()
    return db.collection("services").countDocuments(filter)
  },
  countBookings: async (filter) => {
    const db = await getDb()
    return db.collection("bookings").countDocuments(filter)
  },
  countTransactions: async (filter) => {
    const db = await getDb()
    return db.collection("transactions").countDocuments(filter)
  },
  aggregateRevenue: async () => {
    const db = await getDb()
    return db
      .collection<PaymentTransactionRecord>("transactions")
      .aggregate<RevenueAggregateRow>([
        { $match: { status: { $in: [...SUCCESSFUL_TRANSACTION_STATUSES] } } },
        { $group: { _id: "$currency", amount: { $sum: "$amount" } } },
        { $sort: { _id: 1 } },
      ])
      .toArray()
  },
}

/**
 * Real counts via countDocuments/aggregation. Nothing is loaded into memory
 * just to count, and an empty collection produces valid zeroes.
 */
export async function getAdminOverview(
  deps: AdminOverviewDeps = defaultDeps,
): Promise<AdminOverview> {
  const [
    totalUsers,
    blockedUsers,
    totalVendors,
    totalCustomers,
    totalServices,
    pendingServices,
    approvedActiveServices,
    totalBookings,
    pendingBookings,
    completedBookings,
    totalTransactions,
    successfulTransactions,
    revenueRows,
  ] = await Promise.all([
    deps.countUsers({}),
    deps.countUsers(BLOCKED_USER_FILTER as Filter<Document>),
    deps.countUsers({ role: "vendor" }),
    deps.countUsers({ role: { $nin: ["admin", "vendor"] } }),
    deps.countServices({}),
    deps.countServices({ status: "pending" }),
    deps.countServices({ status: "approved", isActive: true }),
    deps.countBookings({}),
    deps.countBookings({ status: "pending" }),
    deps.countBookings({ status: "completed" }),
    deps.countTransactions({}),
    deps.countTransactions({
      status: { $in: [...SUCCESSFUL_TRANSACTION_STATUSES] },
    }),
    deps.aggregateRevenue(),
  ])

  return {
    totalUsers,
    totalCustomers,
    totalVendors,
    blockedUsers,
    totalServices,
    pendingServices,
    approvedActiveServices,
    totalBookings,
    pendingBookings,
    completedBookings,
    totalTransactions,
    successfulTransactions,
    revenueByCurrency: revenueRows.map((row) => ({
      currency: typeof row._id === "string" ? row._id : "UNKNOWN",
      amount: Number.isFinite(row.amount) ? row.amount : 0,
    })),
  }
}

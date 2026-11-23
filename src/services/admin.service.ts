import { ObjectId, type Filter } from "mongodb"

import { idFilter } from "../lib/object-id.js"
import { getDb } from "../lib/mongodb.js"
import { escapeRegExp } from "../lib/regex.js"
import { normalizeUserRole, type UserRole } from "../types/auth.js"
import type { PaymentTransactionRecord, SubscriptionPlan } from "../types/subscription.js"
import { BLOCKED_USER_FILTER } from "./blocked-vendors.service.js"
import { isBlockedUser } from "./subscriptions.service.js"

export interface AdminUserMutationTarget {
  id: string
  role?: string
}

export interface AdminUserDeps {
  findUser(id: string): Promise<AdminUserMutationTarget | null>
  updateUser(id: string, values: Record<string, unknown>, unset?: string[]): Promise<boolean>
}

export type UserBlockResult =
  | { ok: true }
  | { ok: false; reason: "self" | "not_found" }

export interface AdminServiceDeps {
  deleteService(id: string): Promise<boolean>
}

/** Only these fields are ever read from `users` for admin UI responses. */
export interface AdminUserDocument {
  _id: ObjectId | string
  name?: string
  email?: string
  image?: string | null
  role?: string
  emailVerified?: boolean
  createdAt?: Date | string
  blocked?: boolean
  isBlocked?: boolean
  banned?: boolean
  suspended?: boolean
  status?: string
  accountStatus?: string
  blockedAt?: Date | string
  blockedReason?: string
}

export interface AdminUserView {
  id: string
  name: string
  email: string
  image: string | null
  role: UserRole
  emailVerified: boolean
  createdAt: string | null
  blocked: boolean
  blockedAt: string | null
  blockedReason: string | null
}

export interface AdminUsersQuery {
  search: string
  role: "all" | UserRole
  status: "all" | "active" | "blocked"
  page: number
  pageSize: number
}

export interface AdminUsersMeta {
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export interface AdminUserListDeps {
  countUsers(filter: Filter<AdminUserDocument>): Promise<number>
  findUsers(
    filter: Filter<AdminUserDocument>,
    skip: number,
    limit: number,
  ): Promise<AdminUserDocument[]>
  findUser(id: string): Promise<AdminUserDocument | null>
}

export interface AdminTransactionView {
  id: string
  vendorId: string
  vendorName: string
  plan: SubscriptionPlan
  amount: number
  currency: string
  status: string
  stripeSessionId: string | null
  stripeSubscriptionId: string | null
  createdAt: string | null
}

export interface AdminVendorIdentity {
  id: string
  name: string
}

export interface AdminTransactionDeps {
  findTransactions(limit: number): Promise<PaymentTransactionRecord[]>
  findVendors(vendorIds: string[]): Promise<AdminVendorIdentity[]>
}

const userDeps: AdminUserDeps = {
  findUser: async (id) => {
    const db = await getDb()
    const user = await db
      .collection<AdminUserMutationTarget>("users")
      .findOne(idFilter(id), { projection: { _id: 1, role: 1 } })
    return user ? { id: String(user._id), role: user.role } : null
  },

  updateUser: async (id, values, unset) => {
    const db = await getDb()
    const update: Record<string, unknown> = { $set: values }
    if (unset && unset.length > 0) {
      update.$unset = Object.fromEntries(unset.map((field) => [field, ""]))
    }
    const result = await db.collection("users").updateOne(idFilter(id), update)
    return result.matchedCount > 0
  },
}

const serviceDeps: AdminServiceDeps = {
  deleteService: async (id) => {
    const db = await getDb()
    const result = await db.collection("services").deleteOne(idFilter(id))
    return result.deletedCount > 0
  },
}

const transactionDeps: AdminTransactionDeps = {
  findTransactions: async (limit) => {
    const db = await getDb()
    return db
      .collection<PaymentTransactionRecord>("transactions")
      .find({}, { sort: { createdAt: -1 } })
      .limit(limit)
      .toArray()
  },

  findVendors: async (vendorIds) => {
    if (vendorIds.length === 0) return []

    type VendorUserDocument = { _id: ObjectId | string; name?: string; email?: string }

    const db = await getDb()
    const objectIds: ObjectId[] = []
    const stringIds: string[] = []
    for (const id of vendorIds) {
      if (/^[a-f\d]{24}$/i.test(id)) objectIds.push(new ObjectId(id))
      else stringIds.push(id)
    }

    const or: Filter<VendorUserDocument>[] = []
    if (objectIds.length > 0) or.push({ _id: { $in: objectIds } } as Filter<VendorUserDocument>)
    if (stringIds.length > 0) or.push({ _id: { $in: stringIds } } as Filter<VendorUserDocument>)

    const users = await db
      .collection<VendorUserDocument>("users")
      .find({ $or: or }, { projection: { _id: 1, name: 1, email: 1 } })
      .toArray()

    return users.map((user) => ({
      id: String(user._id),
      name:
        (typeof user.name === "string" && user.name.trim()) ||
        (typeof user.email === "string" && user.email.trim()) ||
        "Unknown vendor",
    }))
  },
}

const ADMIN_USER_PROJECTION = {
  _id: 1,
  name: 1,
  email: 1,
  image: 1,
  role: 1,
  emailVerified: 1,
  createdAt: 1,
  blocked: 1,
  blockedAt: 1,
  blockedReason: 1,
  isBlocked: 1,
  banned: 1,
  suspended: 1,
  status: 1,
  accountStatus: 1,
} as const

const userListDeps: AdminUserListDeps = {
  countUsers: async (filter) => {
    const db = await getDb()
    return db.collection<AdminUserDocument>("users").countDocuments(filter)
  },

  findUsers: async (filter, skip, limit) => {
    const db = await getDb()
    return db
      .collection<AdminUserDocument>("users")
      .find(filter, { projection: ADMIN_USER_PROJECTION })
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .toArray()
  },

  findUser: async (id) => {
    const db = await getDb()
    return db
      .collection<AdminUserDocument>("users")
      .findOne(idFilter(id), { projection: ADMIN_USER_PROJECTION })
  },
}

/** Escapes search input and builds a server-side filter for the admin UI. */
export function adminUsersFilter(query: AdminUsersQuery): Filter<AdminUserDocument> {
  const conditions: Filter<AdminUserDocument>[] = []

  if (query.search) {
    const pattern = escapeRegExp(query.search)
    conditions.push({
      $or: [
        { name: { $regex: pattern, $options: "i" } },
        { email: { $regex: pattern, $options: "i" } },
      ],
    })
  }

  if (query.role !== "all") {
    // Missing/unknown roles normalize to customer, so include them here.
    conditions.push(
      query.role === "customer"
        ? ({ role: { $nin: ["admin", "vendor"] } } as Filter<AdminUserDocument>)
        : ({ role: query.role } as Filter<AdminUserDocument>),
    )
  }

  if (query.status === "blocked") {
    conditions.push(BLOCKED_USER_FILTER as Filter<AdminUserDocument>)
  } else if (query.status === "active") {
    conditions.push({
      $nor: (BLOCKED_USER_FILTER.$or ?? []) as Filter<AdminUserDocument>[],
    })
  }

  return conditions.length > 0 ? { $and: conditions } : {}
}

function toAdminUserView(document: AdminUserDocument): AdminUserView {
  return {
    id: String(document._id),
    name: typeof document.name === "string" ? document.name : "Unnamed user",
    email: typeof document.email === "string" ? document.email : "",
    image: typeof document.image === "string" ? document.image : null,
    role: normalizeUserRole(document.role),
    emailVerified: document.emailVerified === true,
    createdAt: toIso(document.createdAt),
    blocked: isBlockedUser(document),
    blockedAt: toIso(document.blockedAt),
    blockedReason: typeof document.blockedReason === "string" ? document.blockedReason : null,
  }
}

/** Server-side search, role/status filtering and pagination for Manage Users. */
export async function listAdminUsers(
  query: AdminUsersQuery,
  deps: AdminUserListDeps = userListDeps,
): Promise<{ users: AdminUserView[]; meta: AdminUsersMeta }> {
  const filter = adminUsersFilter(query)
  const total = await deps.countUsers(filter)
  const totalPages = Math.max(1, Math.ceil(total / query.pageSize))
  const page = Math.min(query.page, totalPages)
  const documents = await deps.findUsers(filter, (page - 1) * query.pageSize, query.pageSize)

  return {
    users: documents.map(toAdminUserView),
    meta: { page, pageSize: query.pageSize, total, totalPages },
  }
}

/** Admin-only details view built from an explicit allow-list projection. */
export async function getAdminUserById(
  id: string,
  deps: AdminUserListDeps = userListDeps,
): Promise<AdminUserView | null> {
  const document = await deps.findUser(id)
  return document ? toAdminUserView(document) : null
}

/** Blocks or unblocks a user. The actor is compared by verified server identity. */
export async function setUserBlocked(
  id: string,
  blocked: boolean,
  actorId: string,
  reason: string | null,
  deps: AdminUserDeps = userDeps,
): Promise<UserBlockResult> {
  if (blocked && id === actorId) return { ok: false, reason: "self" }

  const target = await deps.findUser(id)
  if (!target) return { ok: false, reason: "not_found" }

  const updated = await deps.updateUser(
    id,
    blocked
      ? {
          blocked: true,
          blockedAt: new Date(),
          ...(reason ? { blockedReason: reason } : {}),
          updatedAt: new Date(),
        }
      : { blocked: false, updatedAt: new Date() },
    blocked ? undefined : ["blockedAt", "blockedReason"],
  )

  return updated ? { ok: true } : { ok: false, reason: "not_found" }
}

/** Permanently removes a service listing by its server-validated id. */
export async function deleteAdminService(
  id: string,
  deps: AdminServiceDeps = serviceDeps,
): Promise<{ ok: true } | { ok: false; reason: "not_found" }> {
  return (await deps.deleteService(id))
    ? { ok: true }
    : { ok: false, reason: "not_found" }
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (typeof value === "string") {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
  }
  return null
}

/** Reads real payment records and attaches vendor display names. */
export async function listAdminTransactions(
  limit = 100,
  deps: AdminTransactionDeps = transactionDeps,
): Promise<AdminTransactionView[]> {
  const transactions = await deps.findTransactions(limit)
  const vendorIds = Array.from(new Set(transactions.map((item) => item.vendorId)))
  const vendors = await deps.findVendors(vendorIds)
  const names = new Map(vendors.map((vendor) => [vendor.id, vendor.name]))

  return transactions.map((item) => ({
    id: String(item._id ?? ""),
    vendorId: item.vendorId,
    vendorName: names.get(item.vendorId) ?? item.vendorId,
    plan: item.plan,
    amount: item.amount,
    currency: item.currency,
    status: item.status,
    stripeSessionId: item.stripeSessionId ?? null,
    stripeSubscriptionId: item.stripeSubscriptionId ?? null,
    createdAt: toIso(item.createdAt),
  }))
}

import { ObjectId, type Filter } from "mongodb"

import { idFilter } from "../lib/object-id.js"
import { getDb } from "../lib/mongodb.js"
import type { PaymentTransactionRecord, SubscriptionPlan } from "../types/subscription.js"

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

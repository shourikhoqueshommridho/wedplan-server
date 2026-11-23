import type { ObjectId, Filter } from "mongodb"

import { getDb } from "../lib/mongodb.js"
import { isBlockedUser } from "./subscriptions.service.js"
import type { ServiceRecord } from "../types/service.js"

/** The block flags already understood by the account-level middleware. */
export interface BlockedVendorCandidate {
  _id: ObjectId | string
  blocked?: boolean
  isBlocked?: boolean
  banned?: boolean
  suspended?: boolean
  status?: string
  accountStatus?: string
}

export interface BlockedVendorDeps {
  findBlockedUsers(): Promise<BlockedVendorCandidate[]>
}

/** The same block flags used by the account-level middleware and admin tools. */
export const BLOCKED_USER_FILTER: Filter<BlockedVendorCandidate> = {
  $or: [
    { blocked: true },
    { isBlocked: true },
    { banned: true },
    { suspended: true },
    { status: { $in: ["blocked", "banned", "suspended"] } },
    { accountStatus: "blocked" },
  ],
}

const defaultDeps: BlockedVendorDeps = {
  findBlockedUsers: async () => {
    const db = await getDb()
    return db
      .collection<BlockedVendorCandidate>("users")
      .find(
        BLOCKED_USER_FILTER,
        {
          projection: {
            _id: 1,
            blocked: 1,
            isBlocked: 1,
            banned: 1,
            suspended: 1,
            status: 1,
            accountStatus: 1,
          },
        },
      )
      .toArray()
  },
}

/** Ids of every user the existing block rules consider blocked. */
export async function listBlockedVendorIds(
  deps: BlockedVendorDeps = defaultDeps,
): Promise<string[]> {
  const users = await deps.findBlockedUsers()
  return users.filter((user) => isBlockedUser(user)).map((user) => String(user._id))
}

/** Empty means no restriction, keeping the query identical for normal traffic. */
export function blockedVendorFilter(blockedIds: readonly string[]): Filter<ServiceRecord> {
  return blockedIds.length > 0 ? { vendorId: { $nin: [...blockedIds] } } : {}
}

export async function getBlockedVendorFilter(
  deps: BlockedVendorDeps = defaultDeps,
): Promise<Filter<ServiceRecord>> {
  return blockedVendorFilter(await listBlockedVendorIds(deps))
}

/** Used by booking creation to reject a vendor blocked after the service load. */
export async function isVendorBlocked(
  vendorId: string,
  deps: BlockedVendorDeps = defaultDeps,
): Promise<boolean> {
  return (await listBlockedVendorIds(deps)).includes(vendorId)
}

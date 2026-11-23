import { ObjectId, type Filter } from "mongodb"

import { getDb } from "../lib/mongodb.js"
import { normalizeUserRole, type UserRole } from "../types/auth.js"

interface AuthUserDocument {
  _id: ObjectId | string
  name?: string
  email?: string
  emailVerified?: boolean
  image?: string | null
  role?: string
  createdAt?: Date | string
}

export interface AuthUserIdentity {
  id: string
  name: string
  email: string
  emailVerified: boolean
  image: string | null
  role: UserRole
  createdAt: string | null
}

function userIdFilter(userId: string): Filter<AuthUserDocument> {
  return /^[a-f\d]{24}$/i.test(userId)
    ? { $or: [{ _id: new ObjectId(userId) }, { _id: userId }] }
    : { _id: userId }
}

function toIsoString(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "string") {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
  }
  return null
}

/**
 * Resolves the identity behind a verified JWT `sub`. This is deliberately a
 * read-only lookup: the role comes from the stored user document, never from
 * request input or from the token payload.
 */
export async function findAuthUserById(userId: string): Promise<AuthUserIdentity | null> {
  const db = await getDb()
  const document = await db.collection<AuthUserDocument>("users").findOne(userIdFilter(userId), {
    projection: {
      _id: 1,
      name: 1,
      email: 1,
      emailVerified: 1,
      image: 1,
      role: 1,
      createdAt: 1,
    },
  })

  if (!document) return null

  return {
    id: String(document._id),
    name: typeof document.name === "string" ? document.name : "",
    email: typeof document.email === "string" ? document.email : "",
    emailVerified: document.emailVerified === true,
    image: typeof document.image === "string" ? document.image : null,
    role: normalizeUserRole(document.role),
    createdAt: toIsoString(document.createdAt),
  }
}

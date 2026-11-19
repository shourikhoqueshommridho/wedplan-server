export const USER_ROLES = ["customer", "vendor", "admin"] as const

export type UserRole = (typeof USER_ROLES)[number]

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === "string" && (USER_ROLES as readonly string[]).includes(value)
}

/** Unknown/missing roles are downgraded to the least-privileged role. */
export function normalizeUserRole(value: unknown): UserRole {
  return isUserRole(value) ? value : "customer"
}

export interface AuthenticatedUser {
  id: string
  name: string
  email: string
  emailVerified: boolean
  image: string | null
  role: UserRole
  createdAt: string | null
}

export interface AuthenticatedSession {
  id: string
  expiresAt: string | null
  createdAt: string | null
}

export interface AuthContext {
  user: AuthenticatedUser
  session: AuthenticatedSession
}

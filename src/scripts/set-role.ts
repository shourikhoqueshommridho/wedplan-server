import "dotenv/config"

import { closeDb, getDb } from "../lib/mongodb.js"
import { USER_ROLES, isUserRole } from "../types/auth.js"

/**
 * Trusted, server-side role assignment. Public sign-up cannot set a role.
 *
 * Usage: npm run set-role -- user@example.com admin
 */
async function main(): Promise<void> {
  const email = process.argv[2]?.trim().toLowerCase()
  const role = process.argv[3]?.trim()

  if (!email || !isUserRole(role)) {
    console.error(`Usage: npm run set-role -- <email> <${USER_ROLES.join("|")}>`)
    process.exitCode = 1
    return
  }

  const db = await getDb()
  const result = await db
    .collection("users")
    .updateOne({ email }, { $set: { role, updatedAt: new Date() } })

  if (result.matchedCount === 0) {
    console.error(`No user found for ${email}.`)
    process.exitCode = 1
    return
  }

  console.log(`Updated ${email} to role "${role}".`)
}

try {
  await main()
} finally {
  await closeDb()
}

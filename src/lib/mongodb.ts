import { MongoClient, type Db } from "mongodb"

const DEFAULT_DB_NAME = "wedplan"

interface MongoCache {
  clientPromise?: Promise<MongoClient>
}

const globalForMongo = globalThis as typeof globalThis & {
  __wedplanMongo?: MongoCache
}

const cache = (globalForMongo.__wedplanMongo ??= {})

/**
 * Returns a single shared MongoClient promise. The cache lives on `globalThis`
 * so `tsx watch` restarts do not open a new pool for every reload.
 */
function getClient(): Promise<MongoClient> {
  const uri = process.env.MONGODB_URI?.trim()

  if (!uri) {
    throw new Error("MONGODB_URI is not configured")
  }

  if (!cache.clientPromise) {
    const client = new MongoClient(uri, {
      appName: "wedplan-api",
      serverSelectionTimeoutMS: 10_000,
    })

    cache.clientPromise = client.connect().catch((error: unknown) => {
      cache.clientPromise = undefined
      void client.close().catch(() => undefined)
      throw error
    })
  }

  return cache.clientPromise
}

export async function getDb(): Promise<Db> {
  const client = await getClient()
  return client.db(process.env.MONGODB_DB?.trim() || DEFAULT_DB_NAME)
}

/**
 * Closes the shared client so short-lived scripts (for example `set-role`)
 * exit instead of keeping the process alive. The API server never calls this.
 */
export async function closeDb(): Promise<void> {
  const pendingClient = cache.clientPromise
  cache.clientPromise = undefined

  if (!pendingClient) return

  const client = await pendingClient
  await client.close()
}

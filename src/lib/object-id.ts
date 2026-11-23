import { ObjectId, type Filter } from "mongodb"

export const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i

export function isObjectId(value: string): boolean {
  return OBJECT_ID_PATTERN.test(value)
}

/**
 * Builds a Mongo `_id` filter without ever calling `new ObjectId()` on user
 * input that is not a 24-hex string. Malformed ids are matched as plain strings
 * so callers never turn a 400-level mistake into a server error. Routes still
 * validate ids with `objectIdSchema` before reaching the database.
 */
export function idFilter<T>(id: string): Filter<T> {
  return (isObjectId(id)
    ? { $or: [{ _id: id }, { _id: new ObjectId(id) }] }
    : { _id: id }) as Filter<T>
}

import type { NextFunction, Request, Response } from "express"

import { getPublicServiceById, listPublicServices } from "../services/services.service.js"
import { serviceIdSchema, serviceQuerySchema } from "../validators/service-query.js"

/**
 * GET /api/services
 * Public, read-only listing. Only approved and active services are returned.
 */
export async function getServices(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const parsedQuery = serviceQuerySchema.safeParse(req.query)

  if (!parsedQuery.success) {
    res.status(400).json({
      success: false,
      message: "Invalid query parameters.",
      errors: parsedQuery.error.issues.map((issue) => ({
        field: issue.path.map(String).join("."),
        message: issue.message,
      })),
    })
    return
  }

  try {
    const result = await listPublicServices(parsedQuery.data)

    res.status(200).json({
      success: true,
      data: result.services,
      meta: {
        total: result.total,
        locations: result.locations,
      },
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /api/services/:id
 * Public detail endpoint. Invalid IDs return 400, while unknown or
 * non-public services return 404.
 */
export async function getServiceById(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const parsedId = serviceIdSchema.safeParse(req.params.id)

  if (!parsedId.success) {
    res.status(400).json({
      success: false,
      message: "Invalid service ID.",
    })
    return
  }

  try {
    const service = await getPublicServiceById(parsedId.data)

    if (!service) {
      res.status(404).json({
        success: false,
        message: "Service not found.",
      })
      return
    }

    res.status(200).json({
      success: true,
      data: service,
    })
  } catch (error) {
    next(error)
  }
}

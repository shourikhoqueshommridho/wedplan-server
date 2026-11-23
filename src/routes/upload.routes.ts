import type { NextFunction, Request, RequestHandler, Response } from "express"
import { Router } from "express"
import multer from "multer"

import { requireRole } from "../middleware/auth.js"
import { requireActiveUser } from "../middleware/blocked.js"
import {
  ImageUploadError,
  MAX_IMAGE_BYTES,
  uploadServiceImage,
  type UploadFile,
} from "../services/image-upload.service.js"

const uploadRouter = Router()

uploadRouter.use(requireRole("vendor"))
uploadRouter.use(requireActiveUser)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
})

function singleImage(field: string): RequestHandler {
  const handler = upload.single(field)

  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, (error: unknown) => {
      if (error) {
        const message =
          error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE"
            ? "Images must be 5 MB or smaller."
            : "The image could not be read. Please try again."
        res.status(400).json({ success: false, message })
        return
      }
      next()
    })
  }
}

/** POST /api/vendor/uploads/image — multipart field name: `image`. */
uploadRouter.post("/image", singleImage("image"), async (req, res, next) => {
  try {
    const result = await uploadServiceImage(req.file as UploadFile | undefined)
    res.status(200).json({ success: true, data: result })
  } catch (error) {
    if (error instanceof ImageUploadError) {
      res.status(error.status).json({ success: false, message: error.message })
      return
    }
    next(error)
  }
})

export default uploadRouter

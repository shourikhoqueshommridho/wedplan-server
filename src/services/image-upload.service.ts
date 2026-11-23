import { getImgbbApiKey, postToImgbb } from "../lib/imgbb.js"

export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

export interface UploadFile {
  buffer: Buffer
  mimetype: string
  originalname: string
  size: number
}

export interface ImageUploadDeps {
  getKey(): string
  post(file: UploadFile, apiKey: string): Promise<string>
}

export class ImageUploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "ImageUploadError"
  }
}

const defaultDeps: ImageUploadDeps = {
  getKey: getImgbbApiKey,
  post: postToImgbb,
}

/** Sniffs the real file type so a renamed/mislabelled file cannot be uploaded. */
export function detectImageMime(buffer: Buffer): string | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg"
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png"
  }
  if (
    buffer.length >= 6 &&
    buffer.subarray(0, 6).toString("ascii") === "GIF87a"
  ) {
    return "image/gif"
  }
  if (
    buffer.length >= 6 &&
    buffer.subarray(0, 6).toString("ascii") === "GIF89a"
  ) {
    return "image/gif"
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp"
  }

  return null
}

export async function uploadServiceImage(
  input: UploadFile | undefined,
  deps: ImageUploadDeps = defaultDeps,
): Promise<{ url: string }> {
  if (!input) {
    throw new ImageUploadError(400, "Choose an image file to upload.")
  }

  if (input.buffer.length === 0) {
    throw new ImageUploadError(400, "The image file is empty.")
  }

  if (input.size > MAX_IMAGE_BYTES || input.buffer.length > MAX_IMAGE_BYTES) {
    throw new ImageUploadError(400, "Images must be 5 MB or smaller.")
  }

  if (!(ALLOWED_IMAGE_TYPES as readonly string[]).includes(input.mimetype)) {
    throw new ImageUploadError(400, "Only JPEG, PNG, WebP and GIF images are supported.")
  }

  const detected = detectImageMime(input.buffer)
  if (!detected || detected !== input.mimetype) {
    throw new ImageUploadError(400, "The file contents do not match the declared image type.")
  }

  let apiKey: string
  try {
    apiKey = deps.getKey()
  } catch {
    throw new ImageUploadError(503, "Image hosting is not configured. Please contact support.")
  }

  let url: string
  try {
    url = await deps.post(input, apiKey)
  } catch {
    // Provider error messages are intentionally not forwarded to the client.
    throw new ImageUploadError(502, "The image could not be uploaded. Please try again.")
  }

  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Invalid URL")
  } catch {
    throw new ImageUploadError(502, "The image host returned an invalid URL.")
  }

  return { url }
}

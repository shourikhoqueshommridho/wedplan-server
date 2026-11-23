const UPLOAD_ENDPOINT = "https://api.imgbb.com/1/upload"

/** The ImgBB key is read only in the backend process and never sent to the browser. */
export function getImgbbApiKey(): string {
  const key = process.env.IMGBB_API_KEY?.trim()
  if (!key) throw new Error("IMGBB_API_KEY is not configured")
  return key
}

export interface ImgbbUploadResponse {
  success?: boolean
  data?: { url?: unknown; display_url?: unknown }
  error?: { message?: unknown }
}

export async function postToImgbb(
  file: { buffer: Buffer; mimetype: string; originalname: string },
  apiKey: string,
): Promise<string> {
  const form = new FormData()
  form.append(
    "image",
    new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }),
    file.originalname || "service-image",
  )

  let response: Response
  try {
    response = await fetch(`${UPLOAD_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new Error("Image hosting service is unavailable")
  }

  if (!response.ok) {
    throw new Error(`Image hosting returned HTTP ${response.status}`)
  }

  let payload: ImgbbUploadResponse
  try {
    payload = (await response.json()) as ImgbbUploadResponse
  } catch {
    throw new Error("Image hosting returned an invalid response")
  }

  const url =
    typeof payload.data?.display_url === "string"
      ? payload.data.display_url
      : typeof payload.data?.url === "string"
        ? payload.data.url
        : null

  if (payload.success !== true || !url) {
    throw new Error("Image hosting rejected the upload")
  }

  return url
}

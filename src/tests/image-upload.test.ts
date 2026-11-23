import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  ImageUploadError,
  detectImageMime,
  uploadServiceImage,
  type ImageUploadDeps,
  type UploadFile,
} from "../services/image-upload.service.js"

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const HOSTED_URL = "https://i.ibb.co/test/service-image.png"

function pngFile(overrides: Partial<UploadFile> = {}): UploadFile {
  return {
    buffer: Buffer.concat([PNG_SIGNATURE, Buffer.from("rest-of-image")]),
    mimetype: "image/png",
    originalname: "service.png",
    size: 1024,
    ...overrides,
  }
}

function deps(overrides: Partial<ImageUploadDeps> = {}) {
  return {
    getKey: () => "test-key",
    post: async () => HOSTED_URL,
    ...overrides,
  }
}

async function expectUploadError(
  promise: Promise<unknown>,
  status: number,
): Promise<ImageUploadError> {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof ImageUploadError)
    assert.equal(error.status, status)
    return error
  }
  assert.fail("Expected the upload to fail")
}

describe("service image validation", () => {
  it("detects real image signatures", () => {
    assert.equal(detectImageMime(PNG_SIGNATURE), "image/png")
    assert.equal(detectImageMime(Buffer.from([0xff, 0xd8, 0xff, 0x00])), "image/jpeg")
    assert.equal(detectImageMime(Buffer.from("GIF89a")), "image/gif")
    assert.equal(detectImageMime(Buffer.from("not an image")), null)
  })

  it("rejects a missing or empty file", async () => {
    await expectUploadError(uploadServiceImage(undefined, deps()), 400)
    await expectUploadError(uploadServiceImage(pngFile({ buffer: Buffer.alloc(0) }), deps()), 400)
  })

  it("rejects unsupported types and oversized files", async () => {
    await expectUploadError(
      uploadServiceImage(
        pngFile({ mimetype: "application/pdf", buffer: Buffer.from("%PDF-1.4") }),
        deps(),
      ),
      400,
    )
    await expectUploadError(
      uploadServiceImage(pngFile({ size: 6 * 1024 * 1024 }), deps()),
      400,
    )
    await expectUploadError(
      uploadServiceImage(pngFile({ buffer: Buffer.alloc(6 * 1024 * 1024) }), deps()),
      400,
    )
  })

  it("rejects a file whose contents do not match its declared type", async () => {
    await expectUploadError(
      uploadServiceImage(pngFile({ buffer: Buffer.from("definitely not png") }), deps()),
      400,
    )
  })
})

describe("ImgBB upload result handling", () => {
  it("returns the hosted URL on success", async () => {
    const result = await uploadServiceImage(pngFile(), deps())
    assert.deepEqual(result, { url: HOSTED_URL })
  })

  it("does not leak provider failures and returns 502", async () => {
    const error = await expectUploadError(
      uploadServiceImage(
        pngFile(),
        deps({
          post: async () => {
            throw new Error("key=super-secret must not be shown")
          },
        }),
      ),
      502,
    )
    assert.ok(!error.message.includes("super-secret"))
  })

  it("reports a safe error when image hosting is not configured", async () => {
    const error = await expectUploadError(
      uploadServiceImage(
        pngFile(),
        deps({
          getKey: () => {
            throw new Error("IMGBB_API_KEY is not configured")
          },
        }),
      ),
      503,
    )
    assert.ok(!error.message.includes("IMGBB_API_KEY"))
  })

  it("rejects an invalid hosted URL", async () => {
    await expectUploadError(
      uploadServiceImage(
        pngFile(),
        deps({ post: async () => "javascript:alert(1)" }),
      ),
      502,
    )
  })
})

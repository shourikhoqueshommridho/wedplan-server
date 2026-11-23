import assert from "node:assert/strict"
import { before, describe, it } from "node:test"
import type { NextFunction, Request, Response } from "express"
import { SignJWT, exportJWK, generateKeyPair, type JSONWebKeySet } from "jose"

import {
  createJwtVerifierFromJwks,
  type JwtVerificationConfig,
  type JwtVerifier,
} from "../lib/jwt.js"
import {
  makeGetAuthContext,
  makeRequireAuth,
  makeRequireRole,
  type AuthContextDeps,
} from "../middleware/auth.js"
import type { AuthContext } from "../types/auth.js"

const config: Omit<JwtVerificationConfig, "jwksUrl"> = {
  issuer: "wedplan",
  audience: "wedplan-api",
  algorithms: ["EdDSA"],
}

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"]

let privateKey: PrivateKey
let verifier: JwtVerifier

before(async () => {
  const pair = await generateKeyPair("EdDSA")
  privateKey = pair.privateKey
  const publicJwk = await exportJWK(pair.publicKey)
  const jwks: JSONWebKeySet = {
    keys: [{ ...publicJwk, alg: "EdDSA", kid: "unit-test-key", use: "sig" }],
  }
  verifier = createJwtVerifierFromJwks(jwks, config)
})

interface SignOptions {
  issuer?: string
  audience?: string
  expiresIn?: string
  subject?: string | false
  role?: string
}

async function signToken(options: SignOptions = {}): Promise<string> {
  let jwt = new SignJWT(options.role ? { role: options.role } : {})
    .setProtectedHeader({ alg: "EdDSA", kid: "unit-test-key" })
    .setIssuer(options.issuer ?? config.issuer)
    .setAudience(options.audience ?? config.audience)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? "15m")

  if (options.subject !== false) {
    jwt = jwt.setSubject(options.subject ?? "user-123")
  }

  return jwt.sign(privateKey)
}

function tamper(token: string): string {
  const parts = token.split(".")
  const signature = parts[2]!
  parts[2] = signature.slice(0, -1) + (signature.endsWith("A") ? "B" : "A")
  return parts.join(".")
}

function mockRes(): Response & { statusCode: number; payload: unknown } {
  const res = {
    statusCode: 0,
    payload: undefined as unknown,
    status(code: number) {
      res.statusCode = code
      return res
    },
    json(payload: unknown) {
      res.payload = payload
      return res
    },
  }
  return res as unknown as Response & { statusCode: number; payload: unknown }
}

function mockReq(headers: Record<string, string> = {}): Request {
  return { headers } as unknown as Request
}

function mockNext(): { next: NextFunction; called: () => boolean } {
  let called = false
  const next = (() => {
    called = true
  }) as NextFunction
  return { next, called: () => called }
}

const storedIdentity = {
  id: "user-123",
  name: "Test User",
  email: "test@example.test",
  emailVerified: true,
  image: null,
  role: "customer" as const,
  createdAt: null,
}

const sessionContext: AuthContext = {
  user: { ...storedIdentity },
  session: { id: "session-1", expiresAt: null, createdAt: null },
}

function deps(overrides: Partial<AuthContextDeps> = {}): AuthContextDeps {
  return {
    verifyJwt: verifier,
    findUserById: async (id) => (id === "user-123" ? { ...storedIdentity } : null),
    sessionContext: async () => sessionContext,
    ...overrides,
  }
}

describe("JWKS JWT verifier", () => {
  it("accepts a valid token and returns its subject", async () => {
    const verified = await verifier(await signToken())
    assert.equal(verified.sub, "user-123")
    assert.equal(verified.payload.iss, config.issuer)
    assert.equal(verified.payload.aud, config.audience)
  })

  it("rejects an expired token", async () => {
    await assert.rejects(async () => verifier(await signToken({ expiresIn: "-1s" })))
  })

  it("rejects an invalid signature", async () => {
    await assert.rejects(async () => verifier(tamper(await signToken())))
  })

  it("rejects a wrong issuer", async () => {
    await assert.rejects(async () => verifier(await signToken({ issuer: "attacker" })))
  })

  it("rejects a wrong audience", async () => {
    await assert.rejects(async () => verifier(await signToken({ audience: "attacker-api" })))
  })

  it("rejects a token without a subject", async () => {
    await assert.rejects(async () => verifier(await signToken({ subject: false })))
  })
})

describe("dual-mode auth context", () => {
  it("uses a verified Bearer token and takes the role from MongoDB", async () => {
    const resolve = makeGetAuthContext(deps())
    const context = await resolve(
      mockReq({ authorization: `Bearer ${await signToken({ role: "admin" })}` }),
    )

    assert.ok(context)
    assert.equal(context.user.id, "user-123")
    // The forged `role: admin` claim is ignored: the stored role wins.
    assert.equal(context.user.role, "customer")
  })

  it("falls back to the cookie session when no Bearer token is sent", async () => {
    let sessionCalls = 0
    const resolve = makeGetAuthContext(
      deps({
        sessionContext: async () => {
          sessionCalls += 1
          return sessionContext
        },
      }),
    )

    const context = await resolve(mockReq({ cookie: "better-auth.session_token=x" }))
    assert.equal(context, sessionContext)
    assert.equal(sessionCalls, 1)
  })

  it("rejects an invalid Bearer token even when a valid cookie exists", async () => {
    const resolve = makeGetAuthContext(deps())
    const context = await resolve(
      mockReq({
        authorization: "Bearer not-a-jwt",
        cookie: "better-auth.session_token=x",
      }),
    )
    assert.equal(context, null)
  })

  it("rejects an empty Bearer token", async () => {
    const resolve = makeGetAuthContext(deps())
    assert.equal(await resolve(mockReq({ authorization: "Bearer" })), null)
  })

  it("rejects a valid token whose subject has no stored user", async () => {
    const resolve = makeGetAuthContext(
      deps({ findUserById: async () => null }),
    )
    assert.equal(await resolve(mockReq({ authorization: `Bearer ${await signToken()}` })), null)
  })
})

describe("existing middleware responses are preserved", () => {
  it("returns 401 when authentication fails", async () => {
    const res = mockRes()
    await makeRequireAuth(async () => null)(mockReq(), res, mockNext().next)
    assert.equal(res.statusCode, 401)
    assert.equal((res.payload as { success: boolean }).success, false)
  })

  it("sets req.auth and continues when authentication succeeds", async () => {
    const req = mockReq()
    const { next, called } = mockNext()
    await makeRequireAuth(async () => sessionContext)(req, resPlaceholder(), next)
    assert.equal(called(), true)
    assert.equal(req.auth, sessionContext)
  })

  it("returns 403 for a disallowed role", async () => {
    const req = mockReq()
    req.auth = sessionContext
    const res = mockRes()
    await makeRequireRole(["admin"])(req, res, mockNext().next)
    assert.equal(res.statusCode, 403)
    assert.equal((res.payload as { success: boolean }).success, false)
  })

  it("allows an authorized role", async () => {
    const req = mockReq()
    req.auth = sessionContext
    const { next, called } = mockNext()
    await makeRequireRole(["customer"])(req, resPlaceholder(), next)
    assert.equal(called(), true)
  })
})

function resPlaceholder(): Response {
  return mockRes()
}

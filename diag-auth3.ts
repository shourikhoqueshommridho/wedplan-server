import "dotenv/config"
import { createServer } from "node:http"
import { getAuthHandler } from "./src/lib/auth.js"

try {
  const handler = await getAuthHandler()
  console.log("HANDLER READY")

  const server = createServer((req, res) => {
    handler(req, res).catch((err) => {
      console.error("HANDLER ERROR:", err && err.message)
      console.error(err && err.stack)
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" })
        res.end(JSON.stringify({ success: false, message: err?.message }))
      }
    })
  })

  server.listen(5001, async () => {
    console.log("DIAG SERVER ON 5001")
    try {
      const response = await fetch("http://localhost:5001/api/auth/get-session")
      console.log("SESSION STATUS", response.status)
      console.log("SESSION BODY", await response.text())
    } catch (e) {
      console.error("FETCH ERROR", e && e.message)
    }
    server.close()
    process.exit(0)
  })
} catch (e) {
  console.error("INIT ERROR", e && e.message)
  console.error(e && e.stack)
  process.exit(1)
}
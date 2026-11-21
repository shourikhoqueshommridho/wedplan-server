import "dotenv/config"
import http from "node:http"
import app from "./src/app.js"

const server = app.listen(5002, async () => {
  console.log("EXPRESS SERVER ON 5002")
  try {
    const response = await fetch("http://localhost:5002/api/auth/get-session")
    console.log("STATUS", response.status)
    const body = await response.text()
    console.log("BODY", body)
  } catch (e) {
    console.error("FETCH ERROR", e && e.message)
  }
  server.close()
  process.exit(0)
})

server.on("error", (e) => {
  console.error("SERVER ERROR", e && e.message)
  process.exit(1)
})
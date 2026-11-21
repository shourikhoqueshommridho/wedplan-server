import "dotenv/config"
import http from "node:http"
import app from "./src/app.js"

const server = app.listen(5003, async () => {
  console.log("EXPRESS SERVER ON 5003")
  try {
    const response = await fetch("http://localhost:5003/api/auth/get-session", {
      headers: {
        "host": "localhost:5003",
        "accept": "application/json",
      }
    })
    console.log("STATUS", response.status)
    const body = await response.text()
    console.log("BODY", body)
  } catch (e) {
    console.error("FETCH ERROR", e && e.message)
  }
  server.close()
  process.exit(0)
})
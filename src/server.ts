import "dotenv/config"
import app from "./app.js"
import { ensureDatabaseIndexes } from "./lib/indexes.js"
import { closeDb } from "./lib/mongodb.js"

const PORT = Number(process.env.PORT) || 5000;

// Index creation is idempotent and non-destructive. A transient database
// failure is logged without secrets; feature-level indexes are also ensured
// lazily on their first use.
ensureDatabaseIndexes().catch((error: unknown) => {
  console.error(
    "[wedplan-api] Startup index check failed:",
    error instanceof Error ? error.name : "unknown error",
  );
});

const server = app.listen(PORT, () => {
  console.log(`WedPlan Server running on port ${PORT}`);
});

/** Long-running hosts send SIGTERM on redeploy; drain and close the pool. */
function shutdown(signal: string): void {
  console.log(`WedPlan Server received ${signal}; shutting down`);
  server.close(() => {
    void closeDb().finally(() => process.exit(0));
  });
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
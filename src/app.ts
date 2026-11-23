import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";

import { checkoutDiagFor, safeErrorInfo } from "./lib/checkout-diagnostics.js";
import { stripeWebhookHandler } from "./controllers/stripe-webhook.controller.js";
import { getAuthHandler, getTrustedOrigins } from "./lib/auth.js";
import accountRouter from "./routes/account.routes.js";
import adminRouter from "./routes/admin.routes.js";
import bookingRouter from "./routes/booking.routes.js";
import servicesRouter from "./routes/services.routes.js";
import stripeRouter from "./routes/stripe.routes.js";
import vendorRouter from "./routes/vendor.routes.js";

const app = express();

app.set("trust proxy", 1)

app.use(helmet());

app.use(
  cors({
    origin: getTrustedOrigins(),
    credentials: true,
  })
);

/**
 * Better Auth must receive the raw request stream, so this route is mounted
 * before `express.json()`. The Next.js app proxies `/api/auth/*` here.
 */
app.all("/api/auth/*splat", async (req, res, next) => {
  try {
    const handler = await getAuthHandler();
    await handler(req, res);
  } catch (error) {
    next(error);
  }
});

/**
 * Stripe must receive the raw request body to verify its signature. This is
 * mounted before express.json(); other JSON API routes are unaffected.
 */
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), stripeWebhookHandler);

app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.status(200).json({
    success: true,
    message: "WedPlan API is running!",
  });
});

app.use("/api/services", servicesRouter);
app.use("/api/stripe", stripeRouter);
app.use("/api/account", accountRouter);
app.use("/api/vendor", vendorRouter);
app.use("/api/bookings", bookingRouter);
app.use("/api/admin", adminRouter);

app.use((_req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    message: "Route not found.",
  });
});

app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  // Sanitized: never emit error messages, which can contain connection strings.
  const info = safeErrorInfo(error);
  console.error(
    "[wedplan-api]",
    JSON.stringify({ errorName: info.errorName, errorCode: info.errorCode })
  );
  checkoutDiagFor(res, "backend-final-error", {
    errorName: info.errorName,
    errorCode: info.errorCode,
  });

  if (res.headersSent) {
    next(error);
    return;
  }

  res.status(500).json({
    success: false,
    message: "Something went wrong. Please try again.",
  });
});

export default app;

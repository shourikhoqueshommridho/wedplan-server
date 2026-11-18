import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";

import servicesRouter from "./routes/services.routes.js";

const app = express();

app.use(helmet());

app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    credentials: true,
  })
);

app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.status(200).json({
    success: true,
    message: "WedPlan API is running!",
  });
});

app.use("/api/services", servicesRouter);

app.use((_req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    message: "Route not found.",
  });
});

app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  console.error(
    "[wedplan-api]",
    error instanceof Error ? error.message : "Unexpected server error"
  );

  if (res.headersSent) {
    next(error);
    return;
  }

  res.status(500).json({
    success: false,
    message: "Something went wrong while loading services. Please try again.",
  });
});

export default app;
